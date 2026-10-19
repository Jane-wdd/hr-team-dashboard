// api.js — Supabase BaaS 直连版 + TTL 缓存层
// 所有方法通过 Supabase JS SDK 调用，签名与页面调用代码完全兼容
// 依赖：supabase-config.js（定义全局 sb 和 STATIC_CONFIG）

// ──────────────────────────────────────────────
// 缓存层：TTL 过期 + 写操作自动失效
// ──────────────────────────────────────────────
const _cache = {
  _store: new Map(),
  DEFAULT_TTL: 30_000,
  LONG_TTL: 120_000,

  get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return null;
    }
    return entry.data;
  },

  set(key, data, ttl = this.DEFAULT_TTL) {
    this._store.set(key, { data, expiresAt: Date.now() + ttl });
  },

  invalidate(pattern) {
    for (const key of this._store.keys()) {
      if (key === pattern || key.startsWith(pattern)) {
        this._store.delete(key);
      }
    }
  },

  clear() {
    this._store.clear();
  },

  size() {
    return this._store.size;
  },
};

// 失效所有与成员相关的缓存
function _invalidateMember(memberId) {
  _cache.invalidate('members');
  _cache.invalidate('memberStats:');
  _cache.invalidate('memberProjects:');
  _cache.invalidate('teamStats');
  _cache.invalidate('quarter');
}

// 失效所有与项目相关的缓存
function _invalidateProjects(memberId) {
  _cache.invalidate('projects');
  _cache.invalidate('teamStats');
  _cache.invalidate('quarter');
  _cache.invalidate('activities');
  if (memberId) _invalidateMember(memberId);
}

// 积分统一保留 2 位小数，消除浮点求和误差
function _round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// 计入「预计完成积分」的项目状态：仅 实施中 / 维护中
const PROJECTED_STATUSES = ['实施中', '维护中'];

// 单个项目对预计完成积分的贡献 = 模块实施积分 × 预计完成系数
// 计入条件：状态为 实施中 / 维护中，且「是否本季度交付/移交」≠ 否
function projectProjectedPoints(p) {
  if (!p) return 0;
  if (p.deliveredThisQuarter === '否') return 0;
  if (!PROJECTED_STATUSES.includes(p.status)) return 0;
  const planned = Number(p.plannedPoints) || 0;
  const coeff = p.coefficient == null ? 1 : Number(p.coefficient);
  return _round2(planned * coeff);
}

// 项目唯一识别码：客户名称 + 项目负责人 + 首次派单日
// 用于新增/导入时去重，避免重复录入同一个项目
function projectKey(p) {
  if (!p) return '';
  const client = String(p.client == null ? '' : p.client).trim().toLowerCase();
  const owner = p.ownerId == null ? '' : String(p.ownerId);
  const start = String(p.startDate == null ? '' : p.startDate).trim();
  return `${client}|${owner}|${start}`;
}

// 不计入团队统计的角色：实施主管（不承接实施项目，其积分不计入团队口径）
const TEAM_EXCLUDED_ROLES = ['实施主管'];
function isTeamCountedMember(m) {
  if (!m) return false;
  return !TEAM_EXCLUDED_ROLES.includes(String(m.role == null ? '' : m.role).trim());
}

const API = {
  // GET /api/quarter — 获取当前季度概览
  async getQuarterOverview() {
    const cached = _cache.get('quarter');
    if (cached) return cached;
    const [quarterRes, membersRes, projectsRes] = await Promise.all([
      sb.from('quarters').select('*').limit(1).single(),
      sb.from('members').select('id,role,quarterlyTarget,currentPoints'),
      sb.from('projects').select('ownerId,status,plannedPoints,coefficient,deliveredThisQuarter')
    ]);
    if (quarterRes.error) { console.error('[API] getQuarterOverview:', quarterRes.error); return { code: 1, data: null }; }
    const quarter = quarterRes.data;
    // 团队积分统一按成员积分汇总（单一数据源）。quarters 表内的积分字段为历史存量，
    // 不再作为计算依据，避免团队看板 / 计算说明页出现与成员工作台不一致的口径。
    // 实施主管等非实施角色不计入团队口径。
    const data = { ...quarter };
    let countedMemberIds = null;
    if (!membersRes.error && membersRes.data) {
      const members = membersRes.data.filter(isTeamCountedMember);
      countedMemberIds = new Set(members.map(m => m.id));
      data.teamTargetPoints = _round2(members.reduce((s, m) => s + (Number(m.quarterlyTarget) || 0), 0));
      data.teamCurrentPoints = _round2(members.reduce((s, m) => s + (Number(m.currentPoints) || 0), 0));
    } else if (membersRes.error) {
      console.error('[API] getQuarterOverview members:', membersRes.error);
    }
    // 预计完成积分 = 当前积分 + Σ(实施中/维护中项目 且 非本季度交付/移交=否 的 模块实施积分 × 预计完成系数)
    if (!projectsRes.error && projectsRes.data) {
      const fromProjects = projectsRes.data
        .filter(p => countedMemberIds === null || countedMemberIds.has(p.ownerId))
        .reduce((s, p) => s + projectProjectedPoints(p), 0);
      data.teamProjectedPoints = _round2((Number(data.teamCurrentPoints) || 0) + fromProjects);
    } else if (projectsRes.error) {
      console.error('[API] getQuarterOverview projects:', projectsRes.error);
    }
    const result = { code: 0, data };
    _cache.set('quarter', result, _cache.LONG_TTL);
    return result;
  },

  // PUT /api/quarter — 更新季度元数据（满意度均分、数据统计截止时间等）
  // 自动跳过库中尚不存在的列（未执行迁移脚本时可安全调用，不会报错中断）
  async updateQuarterMeta(updates) {
    const stripCols = new Set();
    for (let attempt = 0; attempt < 5; attempt++) {
      const payload = Object.fromEntries(
        Object.entries(updates).filter(([k]) => !stripCols.has(k))
      );
      if (Object.keys(payload).length === 0) {
        return { code: 1, data: null, error: { message: `missing columns: ${[...stripCols].join(', ')}` } };
      }
      const { data, error } = await sb.from('quarters').update(payload).eq('id', 1).select().single();
      if (!error) {
        _cache.invalidate('quarter');
        return { code: 0, data, stripped: [...stripCols] };
      }
      const m = error.message && error.message.match(/Could not find the '(\w+)' column/i);
      if (m) { stripCols.add(m[1]); continue; }
      console.error('[API] updateQuarterMeta:', error);
      return { code: 1, data: null, error };
    }
    console.error('[API] updateQuarterMeta: too many missing columns', [...stripCols]);
    return { code: 1, data: null, error: { message: `missing columns: ${[...stripCols].join(', ')}` } };
  },

  // GET /api/members — 获取全部团队成员及积分汇总
  async getMembers() {
    const cached = _cache.get('members');
    if (cached) return cached;
    const [membersRes, projectsRes] = await Promise.all([
      sb.from('members').select('*').order('id'),
      sb.from('projects').select('ownerId,status,plannedPoints,coefficient,deliveredThisQuarter')
    ]);
    if (membersRes.error) { console.error('[API] getMembers:', membersRes.error); return { code: 1, data: null }; }
    const members = membersRes.data || [];
    const projects = projectsRes.data || [];
    // 成员预计完成积分 = 当前积分 + 其名下项目贡献之和（自动计算，覆盖手动值）
    const projectedByOwner = {};
    projects.forEach(p => {
      projectedByOwner[p.ownerId] = (projectedByOwner[p.ownerId] || 0) + projectProjectedPoints(p);
    });
    const data = members.map(m => ({
      ...m,
      projectedPoints: _round2((Number(m.currentPoints) || 0) + (projectedByOwner[m.id] || 0)),
    }));
    const result = { code: 0, data };
    _cache.set('members', result);
    return result;
  },

  async addMember(member) {
    const { group, ...rest } = member;
    const insertData = { ...rest };
    if (group !== undefined) insertData.group = group;
    const { data, error } = await sb.from('members').insert(insertData).select().single();
    if (error) {
      if (error.message && error.message.includes('group')) {
        const { data: data2, error: error2 } = await sb.from('members').insert(rest).select().single();
        if (error2) { console.error('[API] addMember (retry without group):', error2); return { code: 1, data: null }; }
        _invalidateMember();
        return { code: 0, data: data2 };
      }
      console.error('[API] addMember:', error); return { code: 1, data: null };
    }
    _invalidateMember();
    return { code: 0, data };
  },

  async deleteMember(memberId) {
    const { error } = await sb.from('members').delete().eq('id', memberId);
    if (error) { console.error('[API] deleteMember:', error); return { code: 1, data: null }; }
    _invalidateMember();
    return { code: 0 };
  },

  // PUT /api/members/:id — 更新成员信息（自动跳过库中不存在的列）
  async updateMember(memberId, updates) {
    const stripCols = new Set();
    for (let attempt = 0; attempt < 5; attempt++) {
      const payload = Object.fromEntries(
        Object.entries(updates).filter(([k]) => !stripCols.has(k))
      );
      const { data, error } = await sb.from('members').update(payload).eq('id', memberId).select().single();
      if (!error) {
        _invalidateMember(memberId);
        return { code: 0, data, stripped: [...stripCols] };
      }
      const m = error.message && error.message.match(/Could not find the '(\w+)' column/i);
      if (m) { stripCols.add(m[1]); continue; }
      console.error('[API] updateMember:', error);
      return { code: 1, data: null, error };
    }
    console.error('[API] updateMember: too many missing columns', [...stripCols]);
    return { code: 1, data: null, error: { message: `missing columns: ${[...stripCols].join(', ')}` } };
  },

  // GET /api/members/:id — 获取单个成员信息
  async getMember(memberId) {
    const cacheKey = `member:${memberId}`;
    const cached = _cache.get(cacheKey);
    if (cached) return cached;
    const { data, error } = await sb.from('members').select('*').eq('id', memberId).single();
    if (error) { console.error('[API] getMember:', error); return { code: 1, data: null }; }
    const result = { code: 0, data };
    _cache.set(cacheKey, result);
    return result;
  },

  // GET /api/members/:id/projects — 获取指定成员负责的项目列表
  async getMemberProjects(memberId) {
    const cacheKey = `memberProjects:${memberId}`;
    const cached = _cache.get(cacheKey);
    if (cached) return cached;
    const { data, error } = await sb.from('projects').select('*').eq('ownerId', memberId);
    if (error) { console.error('[API] getMemberProjects:', error); return { code: 1, data: null }; }
    const result = { code: 0, data };
    _cache.set(cacheKey, result);
    return result;
  },

  // GET /api/members/:id/stats — 获取成员积分详情（含项目列表）
  async getMemberStats(memberId) {
    const cacheKey = `memberStats:${memberId}`;
    const cached = _cache.get(cacheKey);
    if (cached) return cached;
    const [memberRes, projectsRes] = await Promise.all([
      sb.from('members').select('*').eq('id', memberId).single(),
      sb.from('projects').select('*').eq('ownerId', memberId)
    ]);
    if (memberRes.error) { console.error('[API] getMemberStats:', memberRes.error); return { code: 1, data: null }; }
    const member = memberRes.data;
    const projects = projectsRes.data || [];
    const completedPoints = projects.reduce((s, p) => s + p.completedPoints, 0);
    const plannedPoints = projects.reduce((s, p) => s + p.plannedPoints, 0);
    const projectedPoints = _round2((Number(member.currentPoints) || 0) + projects.reduce((s, p) => s + projectProjectedPoints(p), 0));
    const result = { code: 0, data: { ...member, completedPoints, plannedPoints, projectedPoints, projects } };
    _cache.set(cacheKey, result);
    return result;
  },

  // GET /api/projects — 获取项目列表，支持 status / ownerId 筛选
  async getProjects({ status, ownerId } = {}) {
    const cacheKey = `projects:${status || 'all'}:${ownerId || 'all'}`;
    const cached = _cache.get(cacheKey);
    if (cached) return cached;
    let query = sb.from('projects').select('*');
    if (status) query = query.eq('status', status);
    if (ownerId) query = query.eq('ownerId', ownerId);
    const { data, error } = await query;
    if (error) { console.error('[API] getProjects:', error); return { code: 1, data: null }; }
    const result = { code: 0, data };
    _cache.set(cacheKey, result);
    return result;
  },

  // GET /api/projects/:id — 获取项目详情
  async getProjectById(id) {
    const cacheKey = `project:${id}`;
    const cached = _cache.get(cacheKey);
    if (cached) return cached;
    const { data, error } = await sb.from('projects').select('*').eq('id', id).single();
    if (error) { console.error('[API] getProjectById:', error); return { code: 1, data: null }; }
    const result = { code: 0, data };
    _cache.set(cacheKey, result);
    return result;
  },

  // PUT /api/projects/:id — 更新项目状态
  async updateProjectStatus(id, status) {
    const { data: project, error: fetchErr } = await sb.from('projects').select('*').eq('id', id).single();
    if (fetchErr) { console.error('[API] updateProjectStatus fetch:', fetchErr); return { code: 1, data: null }; }

    const updates = { status };
    if (status === 'completed') {
      updates.progress = 100;
      updates.completedPoints = project.plannedPoints;
      updates.actualEndDate = new Date().toISOString().slice(0, 10);
    }

    const { data: updated, error: updErr } = await sb.from('projects').update(updates).eq('id', id).select().single();
    if (updErr) { console.error('[API] updateProjectStatus update:', updErr); return { code: 1, data: null }; }

    await this._recomputeMember(project.ownerId);

    const statusLabel = STATIC_CONFIG.status[status]?.label || status;
    const { data: member } = await sb.from('members').select('name').eq('id', project.ownerId).single();
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    await sb.from('activities').insert({
      projectId: id,
      member: member?.name || '',
      action: `项目状态更新为「${statusLabel}」`,
      time: now,
    });

    _invalidateProjects(project.ownerId);
    return { code: 0, data: updated };
  },

  // PUT /api/projects/:id — 更新项目（通用）
  async updateProject(id, updates) {
    const { data: project, error: fetchErr } = await sb.from('projects').select('*').eq('id', id).single();
    if (fetchErr) { console.error('[API] updateProject fetch:', fetchErr); return { code: 1, data: null }; }

    const { data: updated, error } = await sb.from('projects').update(updates).eq('id', id).select().single();
    if (error) { console.error('[API] updateProject:', error); return { code: 1, data: null }; }

    await this._recomputeMember(project.ownerId);
    _invalidateProjects(project.ownerId);
    return { code: 0, data: updated };
  },

  // POST /api/projects — 新增项目
  async addProject(project) {
    const { _unmatchedOwner, ...cleanProject } = project;
    if (!cleanProject.id) {
      cleanProject.id = 'P' + Date.now() + Math.floor(Math.random() * 1000);
    }
    if (!cleanProject.status) cleanProject.status = '实施中';
    if (!cleanProject.plannedPoints) cleanProject.plannedPoints = 0;
    if (!cleanProject.completedPoints) cleanProject.completedPoints = 0;
    if (!cleanProject.progress) cleanProject.progress = 0;
    if (!cleanProject.priority) cleanProject.priority = 'medium';
    if (!cleanProject.coefficient) cleanProject.coefficient = 1.0;
    if (!cleanProject.deliveredThisQuarter) cleanProject.deliveredThisQuarter = '是';

    // 去重：客户名称 + 项目负责人 + 首次派单日 完全相同 => 视为同一项目，不再重复插入
    if (cleanProject.client && cleanProject.ownerId && cleanProject.startDate) {
      const { data: dup, error: dupErr } = await sb.from('projects')
        .select('id,client,ownerId,startDate')
        .eq('client', cleanProject.client)
        .eq('ownerId', cleanProject.ownerId)
        .eq('startDate', cleanProject.startDate)
        .limit(1);
      if (dupErr) {
        console.warn('[API] addProject 去重查询失败，跳过去重:', dupErr);
      } else if (dup && dup.length > 0) {
        return { code: 2, duplicate: true, data: dup[0] };
      }
    }

    const stripCols = new Set();
    for (let attempt = 0; attempt < 5; attempt++) {
      const insertData = Object.fromEntries(
        Object.entries(cleanProject).filter(([k]) => !stripCols.has(k))
      );
      const { data, error } = await sb.from('projects').insert(insertData).select().single();
      if (!error) {
        if (insertData.ownerId) await this._recomputeMember(insertData.ownerId);
        _invalidateProjects(insertData.ownerId);
        return { code: 0, data };
      }
      const m = error.message && error.message.match(/Could not find the '(\w+)' column/i);
      if (m) {
        stripCols.add(m[1]);
        continue;
      }
      console.error('[API] addProject:', error);
      return { code: 1, data: null, error };
    }
    console.error('[API] addProject: too many missing columns', [...stripCols]);
    return { code: 1, data: null, error: { message: `missing columns: ${[...stripCols].join(', ')}` } };
  },

  // DELETE /api/projects/:id — 删除项目
  async deleteProject(id) {
    const { data: project, error: fetchErr } = await sb.from('projects').select('ownerId').eq('id', id).single();
    if (fetchErr) { console.error('[API] deleteProject fetch:', fetchErr); return { code: 1, data: null, error: fetchErr }; }

    // activities.projectId 外键引用 projects.id，需先清理关联活动记录
    const { error: actErr } = await sb.from('activities').delete().eq('projectId', id);
    if (actErr) { console.error('[API] deleteProject activities:', actErr); return { code: 1, data: null, error: actErr }; }

    const { error } = await sb.from('projects').delete().eq('id', id);
    if (error) { console.error('[API] deleteProject:', error); return { code: 1, data: null, error }; }

    const ownerId = project && project.ownerId;
    if (ownerId) await this._recomputeMember(ownerId);
    _invalidateProjects(ownerId);
    return { code: 0 };
  },

  // GET /api/stats/team — 获取团队整体统计数据
  async getTeamStats() {
    const cached = _cache.get('teamStats');
    if (cached) return cached;
    const [membersRes, projectsRes, trendRes] = await Promise.all([
      sb.from('members').select('*'),
      sb.from('projects').select('*'),
      sb.from('weeklyTrends').select('*').order('id')
    ]);
    if (membersRes.error) { console.error('[API] getTeamStats members:', membersRes.error); return { code: 1, data: null }; }

    const members = membersRes.data || [];
    const projects = projectsRes.data || [];
    const weeklyTrend = trendRes.data || [];

    const statusCounts = {};
    projects.forEach(p => {
      statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
    });

    // 团队积分按成员积分汇总，与成员工作台保持同一口径；实施主管等非实施角色不计入
    const countedMembers = members.filter(isTeamCountedMember);
    const countedMemberIds = new Set(countedMembers.map(m => m.id));
    const teamTarget = _round2(countedMembers.reduce((sum, m) => sum + (Number(m.quarterlyTarget) || 0), 0));
    const teamCurrent = _round2(countedMembers.reduce((sum, m) => sum + (Number(m.currentPoints) || 0), 0));
    // 预计完成积分 = 当前积分 + Σ(实施中/维护中项目贡献)
    const teamProjected = _round2(teamCurrent + projects
      .filter(p => countedMemberIds.has(p.ownerId))
      .reduce((sum, p) => sum + projectProjectedPoints(p), 0));
    const currentRate = teamTarget > 0 ? parseFloat((teamCurrent / teamTarget * 100).toFixed(2)) : 0;
    const projectedRate = teamTarget > 0 ? parseFloat((teamProjected / teamTarget * 100).toFixed(2)) : 0;

    const result = {
      code: 0,
      data: {
        teamTarget,
        teamCurrent,
        teamProjected,
        currentRate,
        projectedRate,
        statusCounts,
        totalProjects: projects.length,
        completedProjects: statusCounts.completed || 0,
        weeklyTrend,
      },
    };
    _cache.set('teamStats', result);
    return result;
  },

  // GET /api/activities — 获取最近活动记录
  async getActivities(limit = 10) {
    const cacheKey = `activities:${limit}`;
    const cached = _cache.get(cacheKey);
    if (cached) return cached;
    const { data, error } = await sb.from('activities')
      .select('*')
      .order('id', { ascending: false })
      .limit(limit);
    if (error) { console.error('[API] getActivities:', error); return { code: 1, data: null }; }
    const result = { code: 0, data };
    _cache.set(cacheKey, result);
    return result;
  },

  // GET /api/config/status — 获取项目状态配置（纯静态，不缓存到 _cache，直接返回）
  async getStatusConfig() {
    return { code: 0, data: STATIC_CONFIG.status };
  },

  // GET /api/config/priority — 获取优先级配置
  async getPriorityConfig() {
    return { code: 0, data: STATIC_CONFIG.priority };
  },

  // GET /api/weekly-trend — 获取周度积分趋势
  async getWeeklyTrend() {
    const cached = _cache.get('weeklyTrend');
    if (cached) return cached;
    const { data, error } = await sb.from('weeklyTrends').select('*').order('id');
    if (error) { console.error('[API] getWeeklyTrend:', error); return { code: 1, data: null }; }
    const result = { code: 0, data };
    _cache.set('weeklyTrend', result, _cache.LONG_TTL);
    return result;
  },

  // POST /api/store/reset — 重置数据
  async resetData() {
    console.warn('[API] resetData: 请在 Supabase SQL Editor 重新执行 supabase-schema.sql');
    _cache.clear();
    return { code: 0, data: null };
  },

  // 手动清除缓存（供页面"刷新"按钮调用）
  clearCache() {
    _cache.clear();
  },

  // 获取缓存统计（调试用）
  getCacheStats() {
    return { entries: _cache.size(), keys: [..._cache._store.keys()] };
  },

  // 内部方法：重算成员的项目数汇总
  // 注意：成员积分（currentPoints / projectedPoints）由实施主管维护，是团队积分的权威数据源，
  // 不能用项目积分反推——否则项目 completedPoints 未维护时会把成员积分覆盖为 0。
  async _recomputeMember(memberId) {
    const { data: memberProjects } = await sb.from('projects').select('*').eq('ownerId', memberId);
    const projects = memberProjects || [];
    const projectCount = projects.length;
    const completedCount = projects.filter(p => p.status === 'completed').length;
    await sb.from('members').update({
      projectCount,
      completedCount,
    }).eq('id', memberId);
  },
};

if (typeof window !== 'undefined') {
  window.API = API;
  window._cache = _cache;
  window.projectProjectedPoints = projectProjectedPoints;
  window.projectKey = projectKey;
  window.isTeamCountedMember = isTeamCountedMember;
}

// supabase-config.js — Supabase 客户端初始化 + 静态配置常量
//
// 使用前：
// 1. 在 Supabase Dashboard 创建新项目
// 2. 在 SQL Editor 执行 supabase-schema.sql
// 3. 将下面的 URL 和 ANON_KEY 替换为你的项目凭证
//    (Dashboard > Settings > API > Project URL / anon public key)

const SUPABASE_URL = 'https://hgwuhlxwpljiqhigqacy.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhnd3VobHh3cGxqaXFoaWdxYWN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4OTI0OTIsImV4cCI6MjEwNTQ2ODQ5Mn0.dCZCU6crBL2gX79pGvuB5yhxl-nE-QGwFS3Jg14I0Vk';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const STATIC_CONFIG = {
  status: {
    "planning":    { label: "规划中", color: "#94A3B8", bg: "#F1F5F9", icon: "clock" },
    "in-progress": { label: "进行中", color: "#2563EB", bg: "#DBEAFE", icon: "play-circle" },
    "testing":     { label: "测试中", color: "#F59E0B", bg: "#FEF3C7", icon: "flask-conical" },
    "completed":   { label: "已完成", color: "#10B981", bg: "#D1FAE5", icon: "check-circle" },
    "blocked":     { label: "阻塞中", color: "#EF4444", bg: "#FEE2E2", icon: "x-circle" },
  },
  priority: {
    "high":   { label: "高", color: "#EF4444" },
    "medium": { label: "中", color: "#F59E0B" },
    "low":    { label: "低", color: "#10B981" },
  },
};

if (typeof window !== 'undefined') {
  window.sb = sb;
  window.STATIC_CONFIG = STATIC_CONFIG;
}

-- 005_message_status.sql
-- Phase 3：消息生成状态机（流式断点续传基础）
-- status: generating（后台任务生成中）/ done（完成）/ interrupted（中断，可继续生成）
-- error: 中断/失败原因，前端展示用

alter table messages add column if not exists status text not null default 'done'
  check (status in ('generating', 'done', 'interrupted'));

alter table messages add column if not exists error text;

create index if not exists idx_messages_status on messages(status) where status <> 'done';

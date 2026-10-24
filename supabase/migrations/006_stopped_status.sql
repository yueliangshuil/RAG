-- 006_stopped_status.sql
-- 消息生命周期状态机（DEV_LOG #24）：
-- 新增 stopped 状态——用户"主动停止"与"网络断连"语义分离：
-- - stopped：用户主动停止（显式 stop 接口标记），终态，不提供"继续生成"
-- - interrupted：网络断连/宽限期超时/服务重启，保留现场，可继续生成
-- 此前两者共用 interrupted，出现"用户停止后刷新页面任务复活"的语义缺陷。

alter table messages drop constraint if exists messages_status_check;
alter table messages add constraint messages_status_check
  check (status in ('generating', 'done', 'interrupted', 'stopped'));

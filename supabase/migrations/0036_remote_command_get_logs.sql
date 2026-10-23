-- GET_LOGS joins the fixed remote-command allow-list ("Get recent logs" button on the Print server page).
--
-- The Agent's handler reads the tail of its OWN fixed log files and returns them with secrets masked; the command
-- takes no payload and no path ever travels from the cloud (apps/agent/src/log-collector.ts). Only the CHECK
-- constraint needs to learn the new name: no new table, column or function, so there are no new grants to add
-- (remote_commands keeps the policies and grants it already has).
--
-- Until this migration is applied the web app still works: issuing GET_LOGS is refused by this constraint and the
-- admin page says "not available yet" instead of failing silently. After it is applied the button works.

alter table remote_commands drop constraint remote_commands_command_check;
alter table remote_commands add constraint remote_commands_command_check check (command in (
  'REFRESH_PRINTER_STATUS', 'CANCEL_PRINT_JOB', 'RESTART_PRINT_QUEUE',
  'RESTART_AGENT_SERVICE', 'CLEAR_AGENT_TEMP_FILES', 'CHECK_FOR_UPDATE', 'GET_LOGS'
));

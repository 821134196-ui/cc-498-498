'use strict';
// 模拟通知适配器：不接真实短信/微信，落库 notifications 并写本地日志
const fs = require('node:fs');
const path = require('node:path');

function createNotifier(db, logPath) {
  if (logPath) fs.mkdirSync(path.dirname(logPath), { recursive: true });
  return function notify({ target = '客户', title, body }) {
    const created_at = new Date().toISOString();
    db.prepare(
      `INSERT INTO notifications(channel,target,title,body,status,created_at)
       VALUES('mock-sms',?,?,?, '已发送', ?)`)
      .run(target, title, body, created_at);
    const line = `[${created_at}] → ${target} | ${title} | ${body}\n`;
    if (logPath) fs.appendFileSync(logPath, line, 'utf8');
    return { delivered: true, channel: 'mock-sms', target, title, body, at: created_at };
  };
}

module.exports = { createNotifier };

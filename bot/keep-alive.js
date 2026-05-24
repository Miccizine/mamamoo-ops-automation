'use strict';
const http = require('http');

module.exports = function startKeepAlive() {
  http.createServer((_, res) => res.end('ok')).listen(process.env.PORT || 3000);
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) {
    setInterval(() => {
      http.get(url).on('error', () => {});
    }, 10 * 60 * 1000);
  }
};

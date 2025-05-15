const handler = require('./api/scraper');

(async () => {
  const mockReq = {}; // sem dados no req
  const mockRes = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      console.log(`Status: ${this.statusCode}`);
      console.log(JSON.stringify(data, null, 2));
    }
  };

  await handler(mockReq, mockRes);
})();

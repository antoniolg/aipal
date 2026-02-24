const http = require('http');

function createHttpServerService(options) {
    const { port, authToken, onMessageReceived } = options;

    let server = null;

    async function handleRequest(req, res) {
        if (req.method !== 'POST' || req.url !== '/api/messages') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
            return;
        }

        if (authToken) {
            const authHeader = req.headers.authorization;
            if (!authHeader || authHeader !== `Bearer ${authToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
        }

        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const payload = JSON.parse(body);

                if (!payload.text || typeof payload.text !== 'string') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing or invalid "text" field' }));
                    return;
                }

                // Forward to the bot application
                await onMessageReceived({
                    text: payload.text,
                    topicId: payload.topicId,
                    chatId: payload.chatId,
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (err) {
                console.error('Error handling HTTP webhook request:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal Server Error' }));
            }
        });
    }

    function start() {
        if (server) return;

        server = http.createServer(handleRequest);

        server.on('error', (err) => {
            console.error('HTTP server error:', err);
        });

        server.listen(port, () => {
            console.log(`HTTP server listening on port ${port} ${authToken ? '(with authentication)' : '(no authentication configured)'}`);
        });
    }

    function stop() {
        return new Promise((resolve, reject) => {
            if (!server) {
                resolve();
                return;
            }
            server.close((err) => {
                if (err) {
                    reject(err);
                } else {
                    server = null;
                    resolve();
                }
            });
        });
    }

    return {
        start,
        stop,
    };
}

module.exports = {
    createHttpServerService,
};

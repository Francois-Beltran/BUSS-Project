const express = require('express');
const { ExpressPeerServer } = require('peer');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// 1. Static file serving (frontend)
app.use(express.static(path.join(__dirname)));

// 2. PeerJS Server integration
const server = app.listen(port, () => {
    console.log(`[BUSS] Server running on port ${port}`);
});

const peerServer = ExpressPeerServer(server, {
    debug: true,
    path: '/myapp',
    proxied: true // Required for Render/Cloudflare/etc.
});

app.use('/peerjs-server', peerServer);

// 3. Fallback route for SPA (if needed)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const port = process.env.PORT || 3000;

// 1. Static file serving (frontend)
app.use(express.static(path.join(__dirname)));

// 2. Socket.io Cloud Logic
io.on('connection', (socket) => {
    console.log(`[CLOUD] New Unit Linked: ${socket.id}`);

    // Receive location from a phone/unit
    socket.on('send-location', (data) => {
        // Broadcast to all other connected clients (laptops/other units)
        // Adding the sender id so the frontend can identify them
        socket.broadcast.emit('receive-location', { 
            id: socket.id, 
            ...data 
        });
    });

    socket.on('disconnect', () => {
        console.log(`[CLOUD] Unit Unlinked: ${socket.id}`);
        // Notify others to remove this unit from their map
        io.emit('unit-disconnected', socket.id);
    });
});

// 3. Fallback route for SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(port, () => {
    console.log(`[BUSS] Cloud Server running on port ${port}`);
});

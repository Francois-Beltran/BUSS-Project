/**
 * BUSS TRACKER - BACKGROUND WORKER
 * Periodically nudges the main thread to prevent GPS throttling.
 */

let nudgeInterval = null;

self.onmessage = (e) => {
    if (e.data === 'start') {
        if (nudgeInterval) clearInterval(nudgeInterval);
        
        // Nudge every 30 seconds
        nudgeInterval = setInterval(() => {
            self.postMessage('nudge');
        }, 30000);
        
        console.log("[WORKER] Relentless Heartbeat Started");
    }
    
    if (e.data === 'stop') {
        if (nudgeInterval) clearInterval(nudgeInterval);
        console.log("[WORKER] Relentless Heartbeat Stopped");
    }
};

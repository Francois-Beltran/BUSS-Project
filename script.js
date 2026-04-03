/**
 * TOAST NOTIFICATIONS
 */
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icon = type === 'success' ? '<i class="fa-solid fa-circle-check" style="color:#4CAF50"></i>' : '<i class="fa-solid fa-triangle-exclamation" style="color:#f44336"></i>';
    toast.innerHTML = `${icon} <span>${message}</span>`;

    container.appendChild(toast);

    // Remove after animation completes (4s total)
    setTimeout(() => {
        if (container.contains(toast)) container.removeChild(toast);
    }, 4000);
}

/**
 * 1. INITIALIZE MAP
 */
let wakeLock = null;
const elWakeStatus = document.getElementById('wake-status');

async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            if (elWakeStatus) {
                elWakeStatus.textContent = "Always On";
                elWakeStatus.style.color = "#4CAF50";
            }
            wakeLock.addEventListener('release', () => {
                if (elWakeStatus) {
                    elWakeStatus.textContent = "Standby";
                    elWakeStatus.style.color = "#888";
                }
            });
        } catch (err) {
            console.error(`${err.name}, ${err.message}`);
            if (elWakeStatus) elWakeStatus.textContent = "Not Supported";
        }
    }
}

// Re-request wake lock when page becomes visible again
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        await requestWakeLock();
    }
});

const map = L.map('map', {
    zoomControl: false
}).setView([20, 0], 2);

L.control.zoom({ position: 'bottomright' }).addTo(map);

// Google Maps Standard tiles
L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
    attribution: '&copy; Google Maps',
    maxZoom: 20
}).addTo(map);

// Custom Markers
const myIcon = L.divIcon({ className: 'custom-marker', iconSize: [16, 16], iconAnchor: [8, 8] });
const peerIcon = L.divIcon({ className: 'peer-marker', iconSize: [16, 16], iconAnchor: [8, 8] });

let myMarker = null;

// Multi-Peer State Management
const activeConnections = {};
const peerMarkers = {};
const peerUIElements = {}; // Stores dom elements by ID

// GPS Smoothing Buffers
const MAX_BUFFER_SIZE = 5;
const localPathBuffer = [];
const peerPathBuffers = {}; // keys are peerIds

// Diagnostic Counters
let txCount = 0;
let rxCount = 0;
const elTxCount = document.getElementById('tx-count');
const elRxCount = document.getElementById('rx-count');

function updateCounters() {
    if (elTxCount) elTxCount.textContent = txCount;
    if (elRxCount) elRxCount.textContent = rxCount;
}

/**
 * 2. HAVERSINE ALGORITHM
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth's radius in meters
    const toRad = x => x * Math.PI / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * 3. MAP AUTO-FIT LOGIC
 */
function updateMapBounds() {
    // Collect all active markers (including myself)
    const bounds = [];
    if (myMarker) bounds.push(myMarker.getLatLng());

    for (const id in peerMarkers) {
        bounds.push(peerMarkers[id].getLatLng());
    }

    if (bounds.length > 1) {
        map.fitBounds(L.latLngBounds(bounds), { padding: [50, 50], maxZoom: 18 });
    } else if (bounds.length === 1) {
        map.panTo(bounds[0]);
    }
}

/**
 * 4. GEOLOCATION TRACKING ALGORITHM
 */
let lastReportedPosition = null;
const DISTANCE_THRESHOLD = 10; // Set to 10m to reduce stationary movement jitter
const ACCURACY_THRESHOLD = 250; // Relaxed to 250m to support laptops (WiFi triangulation)

const elMyLat = document.getElementById('lat-val');
const elMyLng = document.getElementById('lng-val');
const elMySpeed = document.getElementById('speed-val');
const elMyAcc = document.getElementById('acc-val');
const elGeoStatus = document.getElementById('geo-status');

let myAccuracyCircle = null; // To be removed if not already
// Accuracy circles removed as requested

function updateMyTelemetry(lat, lng, speed, accuracy) {
    elMyLat.textContent = lat.toFixed(5);
    elMyLng.textContent = lng.toFixed(5);
    elMySpeed.textContent = (speed !== null && !isNaN(speed)) ? speed.toFixed(1) : '0.0';
    elMyAcc.textContent = '±' + Math.round(accuracy) + 'm';

    // Update timestamp
    const now = new Date();
    const timeStr = now.getHours().toString().padStart(2, '0') + ':' +
        now.getMinutes().toString().padStart(2, '0') + ':' +
        now.getSeconds().toString().padStart(2, '0');

    const elSync = document.getElementById('last-sync');
    if (elSync) elSync.textContent = timeStr;

    elGeoStatus.textContent = "Tracking Active";
    elGeoStatus.style.color = "#4CAF50";
}

/**
 * UTILITY: Calculates a Weighted Moving Average (WMA) of coordinates
 * favoring points with better (lower) accuracy values for stability.
 */
function getSmoothedCoords(buffer) {
    if (buffer.length === 0) return null;
    if (buffer.length === 1) return buffer[0];

    let latSum = 0;
    let lngSum = 0;
    let accSum = 0;
    let weightSum = 0;

    // Use current baseline accuracy to calculate dynamic weighting
    const avgAccuracy = buffer.reduce((sum, p) => sum + p.accuracy, 0) / buffer.length;

    buffer.forEach(p => {
        // Points with accuracy better (smaller) than average get more weight
        // weight = baseline / current. If current=5m and avg=20m, weight = 4.
        const weight = avgAccuracy / (p.accuracy || 1);
        latSum += p.lat * weight;
        lngSum += p.lng * weight;
        accSum += p.accuracy * weight;
        weightSum += weight;
    });

    return {
        lat: latSum / weightSum,
        lng: lngSum / weightSum,
        accuracy: accSum / weightSum
    };
}

/**
 * REPLACEMENT LOGIC: Unified handler for local GPS and Peer updates
 * Rejects "Ghost Movement" (<2m jitter) and applies smoothing.
 */
function handleLocationUpdate(source, lat, lng, speed, accuracy) {
    const buffer = source === 'local' ? localPathBuffer : (peerPathBuffers[source] || (peerPathBuffers[source] = []));

    // 1. Calculate current smoothed position for the distance check
    const currentSmoothed = getSmoothedCoords(buffer);

    // 2. DISTANCE SENSITIVITY: Rejection threshold if too close to current average
    if (currentSmoothed) {
        const distFromCenter = calculateHaversineDistance(currentSmoothed.lat, currentSmoothed.lng, lat, lng);
        if (distFromCenter < 5) {
            console.log(`[Smoothing] Stationary Jitter Rejected (${distFromCenter.toFixed(2)}m deviation)`);
            return;
        }
    }

    // 3. Add to sliding buffer
    buffer.push({ lat, lng, accuracy });
    if (buffer.length > MAX_BUFFER_SIZE) buffer.shift();

    // 4. Calculate NEW smoothed result
    const smoothed = getSmoothedCoords(buffer);

    // 5. UPDATE MAP & TELEMETRY
    if (source === 'local') {
        updateMyTelemetry(smoothed.lat, smoothed.lng, speed, smoothed.accuracy);
        lastReportedPosition = { lat: smoothed.lat, lng: smoothed.lng };

        if (!myMarker) {
            myMarker = L.marker([smoothed.lat, smoothed.lng], { icon: myIcon }).addTo(map);
            map.setView([smoothed.lat, smoothed.lng], 17);
        } else {
            myMarker.setLatLng([smoothed.lat, smoothed.lng]);
        }

        // Broadast smoothed data to fleet
        for (const id in activeConnections) {
            const conn = activeConnections[id];
            if (conn && conn.open) {
                conn.send({ type: 'location', lat: smoothed.lat, lng: smoothed.lng, accuracy: smoothed.accuracy });
                txCount++;
            }
        }
        updateCounters();

        // HEARTBEAT to Service Worker
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({
                type: 'HEARTBEAT', lat: smoothed.lat, lng: smoothed.lng, timestamp: Date.now()
            });
        }
    } else {
        // Update Peer Logic (Source is PeerId)
        if (peerUIElements[source]) {
            const ui = peerUIElements[source];
            ui.lat.textContent = smoothed.lat.toFixed(5);
            ui.lng.textContent = smoothed.lng.toFixed(5);

            if (lastReportedPosition) {
                const dist = calculateHaversineDistance(lastReportedPosition.lat, lastReportedPosition.lng, smoothed.lat, smoothed.lng);
                ui.dist.textContent = dist > 1000 ? (dist / 1000).toFixed(2) + ' km' : Math.round(dist) + ' m';
            }
        }

        if (!peerMarkers[source]) {
            peerMarkers[source] = L.marker([smoothed.lat, smoothed.lng], { icon: peerIcon, zIndexOffset: -100 }).addTo(map);
        } else {
            peerMarkers[source].setLatLng([smoothed.lat, smoothed.lng]);
        }
    }

    updateMapBounds();
}

if ("geolocation" in navigator) {
    navigator.geolocation.watchPosition(
        (position) => {
            const { latitude, longitude, speed, accuracy } = position.coords;

            // Filter by accuracy threshold first
            if (accuracy > ACCURACY_THRESHOLD) {
                console.warn(`[GPS] Ignoring noisy signal: ±${Math.round(accuracy)}m`);
                elMyAcc.style.color = '#FF5722';
                return;
            }
            elMyAcc.style.color = '';

            // Delegate to the smoothing filter
            handleLocationUpdate('local', latitude, longitude, speed, accuracy);
        },
        (error) => {
            console.error("Geolocation error:", error);
            let errMsg = error.message;
            if (error.code === 1) errMsg = "Permission Denied";
            elGeoStatus.textContent = "Error: " + errMsg;
            elGeoStatus.style.color = "#FF5722";
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
} else {
    elGeoStatus.textContent = "Browser not supported";
    elGeoStatus.style.color = "#FF5722";
}

/**
 * 5. PEER-TO-PEER (WebRTC) FLEET LOGIC
 */
function generateShortId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}
const peer = new Peer(generateShortId());

const elMyId = document.getElementById('my-id');
const elPeerInput = document.getElementById('peer-id-input');
const btnConnect = document.getElementById('connect-btn');
const elStatus = document.getElementById('connection-status');
const peersContainer = document.getElementById('peers-container');

// Copy ID to clipboard
elMyId.addEventListener('click', () => {
    navigator.clipboard.writeText(elMyId.textContent);
    showToast('ID copied to clipboard!', 'success');
});

// Create dynamic HTML cards for peers
function createPeerCard(peerId) {
    if (document.getElementById(`peer-card-${peerId}`)) return; // Already exists

    // Auto generate a color based on ID length or string, for simple distinction
    const cardColor = "#4CAF50";

    const card = document.createElement('div');
    card.className = 'card';
    card.id = `peer-card-${peerId}`;
    card.style.borderLeftColor = cardColor;

    card.innerHTML = `
        <h2 style="color: ${cardColor}; margin-bottom: 2px;"><i class="fa-solid fa-car-side"></i> Fleet Unit</h2>
        <div style="font-size: 0.7rem; color: #bbb; margin-bottom: 12px; font-family: monospace;"><i class="fa-solid fa-fingerprint"></i> ${peerId}</div>
        <div class="data-row">
            <span class="data-label"><i class="fa-solid fa-arrows-up-down"></i> Lat:</span>
            <span class="data-value" id="peer-lat-${peerId}">--</span>
        </div>
        <div class="data-row">
            <span class="data-label"><i class="fa-solid fa-arrows-left-right"></i> Lng:</span>
            <span class="data-value" id="peer-lng-${peerId}">--</span>
        </div>
        <div class="data-row">
            <span class="data-label"><i class="fa-solid fa-ruler"></i> Dist:</span>
            <span class="data-value" id="peer-dist-${peerId}">--</span>
        </div>
    `;

    peersContainer.appendChild(card);

    // Store references safely (using document.getElementById to avoid CSS selector syntax errors if UUIDs start with a number)
    peerUIElements[peerId] = {
        card: card,
        lat: document.getElementById(`peer-lat-${peerId}`),
        lng: document.getElementById(`peer-lng-${peerId}`),
        dist: document.getElementById(`peer-dist-${peerId}`)
    };
}

function removePeerCard(peerId) {
    if (peerUIElements[peerId]) {
        peersContainer.removeChild(peerUIElements[peerId].card);
        delete peerUIElements[peerId];
    }
}

function updateConnectionStatusCount() {
    const count = Object.keys(activeConnections).length;
    if (count > 0) {
        elStatus.textContent = `Connected to ${count} peer(s)`;
        elStatus.className = 'status connected';
    } else {
        elStatus.textContent = 'Waiting for connections...';
        elStatus.className = 'status';
    }
}

// Lifecycle handler for connections
let lastTargetPeerId = null; // Memory for auto-reconnect

function setupConnection(conn) {
    const peerId = conn.peer;
    activeConnections[peerId] = conn;

    // Remember this ID for potential auto-reconnect
    lastTargetPeerId = peerId;

    conn.on('open', () => {
        updateConnectionStatusCount();
        createPeerCard(peerId);
        showToast(`Connected to peer: ${peerId.substring(0, 6)}`, 'success');

        // 2. Immediately send my CURRENT position if I have it
        if (lastReportedPosition) {
            conn.send({
                type: 'location',
                lat: lastReportedPosition.lat,
                lng: lastReportedPosition.lng,
                accuracy: localPathBuffer.length > 0 ? localPathBuffer[localPathBuffer.length - 1].accuracy : 20
            });
            txCount++;
            updateCounters();
        }
    });

    conn.on('data', (data) => {
        // Packet received - count immediately to ensure 1-1 network tracking
        rxCount++;
        updateCounters();

        if (data.type === 'location') {
            handleLocationUpdate(peerId, data.lat, data.lng, null, data.accuracy || 20);
        }
    });

    conn.on('close', () => {
        // Cleanup on disconnect
        removePeerCard(peerId);
        if (peerMarkers[peerId]) {
            map.removeLayer(peerMarkers[peerId]);
            delete peerMarkers[peerId];
        }
        delete activeConnections[peerId];
        updateConnectionStatusCount();
        updateMapBounds();
        showToast(`Peer disconnected: ${peerId.substring(0, 6)}`, 'error');

        // AUTO-RECONNECT LOGIC: If we were the one who initiated, try to reconnect
        if (peerId === lastTargetPeerId) {
            console.log(`[P2P] Connection lost to ${peerId}. Retrying in 5s...`);
            elStatus.textContent = 'Reconnecting...';
            setTimeout(() => {
                if (!activeConnections[peerId]) {
                    const newConn = peer.connect(peerId, { reliable: true });
                    setupConnection(newConn);
                }
            }, 5000);
        }
    });

    conn.on('error', (err) => {
        console.error(`Conn Error [${peerId}]:`, err);
    });
}

// Sidebar Toggle Logic
const sidebarHeader = document.getElementById('sidebar-header');
const sidebarContent = document.getElementById('sidebar-content');
const toggleBtn = document.getElementById('toggle-btn');
const toggleIcon = toggleBtn.querySelector('i');

let isCollapsed = false;
sidebarHeader.addEventListener('click', () => {
    isCollapsed = !isCollapsed;
    if (isCollapsed) {
        sidebarContent.style.display = 'none';
        toggleIcon.className = 'fa-solid fa-chevron-up';
    } else {
        sidebarContent.style.display = 'flex';
        toggleIcon.className = 'fa-solid fa-chevron-down';
    }
});

// 1. Event: Generated ID
peer.on('open', (id) => {
    elMyId.textContent = id;
    showToast('Connected to fleet network!', 'success');
    requestWakeLock(); // Try to keep screen on once app is ready
});

// 2. Event: Incoming Connection
peer.on('connection', (conn) => {
    setupConnection(conn);
    showToast(`Incoming connection...`, 'success');
});

// 3. Event: Outgoing Connection
btnConnect.addEventListener('click', () => {
    const targetId = elPeerInput.value.trim();
    if (!targetId) return;

    if (activeConnections[targetId]) {
        showToast("Already connected to this peer!", "error");
        return;
    }

    elStatus.textContent = 'Connecting...';
    const conn = peer.connect(targetId, { reliable: true });
    setupConnection(conn);

    elPeerInput.value = ''; // clear input
});

peer.on('error', (err) => {
    console.error("PeerJS Error:", err);
    elStatus.textContent = 'Network Error';
    setTimeout(updateConnectionStatusCount, 2000); // revert to general state
});

/**
 * 6. PWA SERVICE WORKER REGISTRATION
 */
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => {
                console.log('[PWA] Service Worker active for scope:', reg.scope);
            })
            .catch(err => {
                console.error('[PWA] Registration failed:', err);
            });
    });
}

/**
 * 8. REFRESH & CACHE PURGE LOGIC
 */
document.getElementById('refresh-btn').addEventListener('click', () => {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(registrations => {
            for (let registration of registrations) {
                registration.unregister();
            }
            showToast('Purging cache & updating...', 'success');
            setTimeout(() => {
                window.location.reload(true);
            }, 1000);
        });
    } else {
        window.location.reload(true);
    }
});

/**
 * 7. PWA INSTALLATION UI LOGIC
 */
let deferredPrompt;
const installCard = document.getElementById('install-card');
const installBtn = document.getElementById('install-btn');
const iosInfo = document.getElementById('ios-install-info');

// Detect standalone mode (hide card if already installed)
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
if (!isStandalone) {
    // Show the card
    installCard.style.display = 'block';

    // Check if iOS to show specific instructions
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
        iosInfo.style.display = 'block';
    }
}

// Android/Chrome specific popup handling
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.style.display = 'block'; // Only show button for Chrome
});

installBtn.addEventListener('click', async () => {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
            installCard.style.display = 'none';
        }
        deferredPrompt = null;
    }
});

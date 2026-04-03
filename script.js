/**
 * BUSS TRACKER - CLOUD MIGRATION
 * Refactored for Socket.io + Cloud-First Fleet Tracking
 */

// --- 1. TOAST NOTIFICATIONS ---
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? '<i class="fa-solid fa-circle-check" style="color:#4CAF50"></i>' : '<i class="fa-solid fa-triangle-exclamation" style="color:#f44336"></i>';
    toast.innerHTML = `${icon} <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => { if (container.contains(toast)) container.removeChild(toast); }, 4000);
}

// --- 2. MAP INITIALIZATION ---
let wakeLock = null;
const elWakeStatus = document.getElementById('wake-status');

async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            if (elWakeStatus) { elWakeStatus.textContent = "Always On"; elWakeStatus.style.color = "#4CAF50"; }
        } catch (err) { console.error(err); }
    }
}

const map = L.map('map', { zoomControl: false }).setView([20, 0], 2);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', { attribution: '&copy; Google Maps', maxZoom: 20 }).addTo(map);

const myIcon = L.divIcon({ className: 'custom-marker', iconSize: [16, 16], iconAnchor: [8, 8] });
const peerIcon = L.divIcon({ className: 'peer-marker', iconSize: [16, 16], iconAnchor: [8, 8] });

let myMarker = null;
const fleetMarkers = {}; // Stores markers for other units
const fleetUIElements = {}; // Stores UI references for other units

// --- 3. CLOUD CONNECTION (Socket.io) ---
// Initialize connection to the Render server
const socket = io('https://buss-project.onrender.com');

const elStatus = document.getElementById('connection-status');
const elMyId = document.getElementById('my-id');
const peersContainer = document.getElementById('peers-container');

socket.on('connect', () => {
    elStatus.textContent = "Synced to Cloud";
    elStatus.style.color = "#4CAF50";
    elMyId.textContent = socket.id.substring(0, 8).toUpperCase();
    showToast("Connected to Fleet Cloud", "success");
    requestWakeLock();
    
    // BURST SYNC: Send buffered points if any
    flushOfflineBuffer();
});

socket.on('disconnect', () => {
    elStatus.textContent = "Offline (Buffering)";
    elStatus.style.color = "#FF5722";
    showToast("Connection Lost - Buffering Enabled", "error");
});

// --- 4. SMOOTHING & TELEMETRY LOGIC ---
const MAX_BUFFER_SIZE = 5;
const localSmoothingBuffer = [];
const DISTANCE_THRESHOLD = 2; // Only emit if moved > 2 meters
const ACCURACY_THRESHOLD = 100; // Only emit if accuracy < 100 meters

let lastEmittedPosition = null;
const offlineBuffer = []; // Cache points during disconnect

let txCount = 0;
let rxCount = 0;
const elTxCount = document.getElementById('tx-count');
const elRxCount = document.getElementById('rx-count');

function calculateHaversine(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getSmoothedCoords(buffer) {
    if (!buffer.length) return null;
    let latSum = 0, lngSum = 0, accSum = 0;
    buffer.forEach(p => { latSum += p.lat; lngSum += p.lng; accSum += p.accuracy; });
    return { lat: latSum / buffer.length, lng: lngSum / buffer.length, accuracy: accSum / buffer.length };
}

function handleLocationUpdate(lat, lng, speed, accuracy) {
    // 1. Accuracy Filter
    if (accuracy > ACCURACY_THRESHOLD) return;

    // 2. Add to smoothing buffer
    localSmoothingBuffer.push({ lat, lng, accuracy });
    if (localSmoothingBuffer.length > MAX_BUFFER_SIZE) localSmoothingBuffer.shift();

    const smoothed = getSmoothedCoords(localSmoothingBuffer);
    if (!smoothed) return;

    // 3. Distance Filter (vs last emitted)
    if (lastEmittedPosition) {
        const dist = calculateHaversine(lastEmittedPosition.lat, lastEmittedPosition.lng, smoothed.lat, smoothed.lng);
        if (dist < DISTANCE_THRESHOLD) return;
    }

    // 4. Update Local Map & UI
    updateLocalUI(smoothed.lat, smoothed.lng, speed, smoothed.accuracy);
    
    // 5. Cloud Emitter
    const payload = { lat: smoothed.lat, lng: smoothed.lng, speed, accuracy: smoothed.accuracy, timestamp: Date.now() };
    
    if (socket.connected) {
        socket.emit('send-location', payload, (ack) => {
            txCount++;
            if (elTxCount) elTxCount.textContent = txCount;
        });
    } else {
        offlineBuffer.push(payload);
    }
    
    lastEmittedPosition = smoothed;
}

function updateLocalUI(lat, lng, speed, accuracy) {
    document.getElementById('lat-val').textContent = lat.toFixed(5);
    document.getElementById('lng-val').textContent = lng.toFixed(5);
    document.getElementById('speed-val').textContent = (speed || 0).toFixed(1);
    document.getElementById('acc-val').textContent = `±${Math.round(accuracy)}m`;
    document.getElementById('last-sync').textContent = new Date().toLocaleTimeString();
    
    if (!myMarker) {
        myMarker = L.marker([lat, lng], { icon: myIcon }).addTo(map);
        map.setView([lat, lng], 17);
    } else {
        myMarker.setLatLng([lat, lng]);
    }
    updateMapBounds();
}

function flushOfflineBuffer() {
    if (offlineBuffer.length > 0) {
        console.log(`[Cloud] Burst Syncing ${offlineBuffer.length} points...`);
        offlineBuffer.forEach(data => {
            socket.emit('send-location', data);
            txCount++;
        });
        if (elTxCount) elTxCount.textContent = txCount;
        offlineBuffer.length = 0;
        showToast("Offline data synced!", "success");
    }
}

// --- 5. CLOUD LISTENERS (Laptop Mode) ---
socket.on('receive-location', (data) => {
    rxCount++;
    if (elRxCount) elRxCount.textContent = rxCount;

    const { id, lat, lng, speed, accuracy } = data;
    
    // Create UI card for peer if it doesn't exist
    if (!fleetUIElements[id]) createFleetCard(id);
    
    const ui = fleetUIElements[id];
    ui.lat.textContent = lat.toFixed(5);
    ui.lng.textContent = lng.toFixed(5);
    
    if (lastEmittedPosition) {
        const d = calculateHaversine(lastEmittedPosition.lat, lastEmittedPosition.lng, lat, lng);
        ui.dist.textContent = d > 1000 ? (d/1000).toFixed(2) + 'km' : Math.round(d) + 'm';
    }

    // Map Marker Logic
    if (!fleetMarkers[id]) {
        fleetMarkers[id] = L.marker([lat, lng], { icon: peerIcon }).addTo(map);
    } else {
        fleetMarkers[id].setLatLng([lat, lng]);
    }
    updateMapBounds();
});

socket.on('unit-disconnected', (id) => {
    if (fleetMarkers[id]) { map.removeLayer(fleetMarkers[id]); delete fleetMarkers[id]; }
    if (fleetUIElements[id]) { peersContainer.removeChild(fleetUIElements[id].card); delete fleetUIElements[id]; }
    updateMapBounds();
});

function createFleetCard(id) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
        <h2 style="color:#4CAF50; margin-bottom:2px;"><i class="fa-solid fa-car-side"></i> Fleet Unit</h2>
        <div style="font-size:0.7rem; color:#888; margin-bottom:10px;">ID: ${id.substring(0,6)}</div>
        <div class="data-row"><span class="data-label">Lat:</span><span class="data-value" id="lat-${id}">--</span></div>
        <div class="data-row"><span class="data-label">Lng:</span><span class="data-value" id="lng-${id}">--</span></div>
        <div class="data-row"><span class="data-label">Dist:</span><span class="data-value" id="dist-${id}">--</span></div>
    `;
    peersContainer.appendChild(card);
    fleetUIElements[id] = {
        card: card,
        lat: document.getElementById(`lat-${id}`),
        lng: document.getElementById(`lng-${id}`),
        dist: document.getElementById(`dist-${id}`)
    };
}

function updateMapBounds() {
    const group = [];
    if (myMarker) group.push(myMarker.getLatLng());
    Object.values(fleetMarkers).forEach(m => group.push(m.getLatLng()));
    if (group.length > 1) map.fitBounds(L.latLngBounds(group), { padding: [50, 50] });
    else if (group.length === 1) map.panTo(group[0]);
}

// --- 6. GEOLOCATION WATCHER ---
if ("geolocation" in navigator) {
    navigator.geolocation.watchPosition(
        (pos) => { handleLocationUpdate(pos.coords.latitude, pos.coords.longitude, pos.coords.speed, pos.coords.accuracy); },
        (err) => { console.error(err); document.getElementById('geo-status').textContent = "GPS Error"; },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
}

// --- 7. UTILS ---
document.getElementById('refresh-btn').addEventListener('click', () => window.location.reload());
document.getElementById('my-id').addEventListener('click', () => {
    navigator.clipboard.writeText(socket.id);
    showToast("Full ID copied!", "success");
});

// Sidebar Toggle
let isCollapsed = false;
document.getElementById('sidebar-header').addEventListener('click', () => {
    isCollapsed = !isCollapsed;
    document.getElementById('sidebar-content').style.display = isCollapsed ? 'none' : 'flex';
    document.getElementById('toggle-btn').querySelector('i').className = isCollapsed ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
});

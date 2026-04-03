/**
 * BUSS TRACKER - CLOUD MIGRATION + STABILITY REFACTOR
 * Refactored for Unit-01 Precision & Camera Control
 */

// --- STATIC CONFIG ---
const BUS_UNIT_ID = 'UNIT-01'; // Static ID to prevent Ghost Markers
let followMe = true;           // Camera behavior toggle

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
    if ('wakeLock' in navigator && !wakeLock) {
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
let myPath = L.polyline([], { color: '#FF5722', weight: 4, opacity: 0.6, lineCap: 'round', lineJoin: 'round' }).addTo(map);

const fleetMarkers = {}; 
const fleetPaths = {}; 
const fleetUIElements = {}; 

const MAX_PATH_POINTS = 50; 

// --- 3. CLOUD CONNECTION ---
const socket = io('https://buss-project.onrender.com');
const elStatus = document.getElementById('connection-status');
const elMyId = document.getElementById('my-id');
const peersContainer = document.getElementById('peers-container');

socket.on('connect', () => {
    elStatus.textContent = "Synced to Cloud";
    elStatus.style.color = "#4CAF50";
    elMyId.textContent = BUS_UNIT_ID;
    showToast("Connected to Fleet Cloud", "success");
    requestWakeLock();
    flushOfflineBuffer();
});

socket.on('disconnect', () => {
    elStatus.textContent = "Offline (Buffering)";
    elStatus.style.color = "#FF5722";
    showToast("Connection Lost - Buffering Enabled", "error");
});

// --- 4. SNAP-TO-ROAD (OSRM API) ---
async function fetchSnappedLocation(lat, lng) {
    try {
        const response = await fetch(`https://router.project-osrm.org/nearest/v1/driving/${lng},${lat}?number=1`);
        const data = await response.json();
        if (data.code === 'Ok' && data.waypoints?.length > 0) {
            const [snappedLng, snappedLat] = data.waypoints[0].location;
            return { lat: snappedLat, lng: snappedLng };
        }
    } catch (e) {}
    return { lat, lng };
}

// --- 5. SMOOTHING & TELEMETRY ---
const localSmoothingBuffer = [];
const DISTANCE_THRESHOLD = 2; 
const ACCURACY_THRESHOLD = 100; 

let lastEmittedPosition = null;
const offlineBuffer = []; 

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

async function handleLocationUpdate(lat, lng, speed, accuracy) {
    if (accuracy > ACCURACY_THRESHOLD) return;
    localSmoothingBuffer.push({ lat, lng, accuracy });
    if (localSmoothingBuffer.length > 5) localSmoothingBuffer.shift();
    const smoothed = getSmoothedCoords(localSmoothingBuffer);
    if (!smoothed) return;

    const snapped = await fetchSnappedLocation(smoothed.lat, smoothed.lng);
    if (lastEmittedPosition) {
        const dist = calculateHaversine(lastEmittedPosition.lat, lastEmittedPosition.lng, snapped.lat, snapped.lng);
        if (dist < DISTANCE_THRESHOLD) return;
    }

    updateLocalUI(snapped.lat, snapped.lng, speed, smoothed.accuracy);
    
    // PAYLOAD WITH STATIC BUS NAME
    const payload = { 
        busName: BUS_UNIT_ID, 
        lat: snapped.lat, 
        lng: snapped.lng, 
        speed, 
        accuracy: smoothed.accuracy, 
        timestamp: Date.now() 
    };

    if (socket.connected) {
        socket.emit('send-location', payload, (ack) => {
            txCount++; if (elTxCount) elTxCount.textContent = txCount;
        });
    } else {
        offlineBuffer.push(payload);
    }
    lastEmittedPosition = snapped;
}

function updateLocalUI(lat, lng, speed, accuracy) {
    document.getElementById('lat-val').textContent = lat.toFixed(5);
    document.getElementById('lng-val').textContent = lng.toFixed(5);
    document.getElementById('speed-val').textContent = (speed || 0).toFixed(1);
    document.getElementById('acc-val').textContent = `±${Math.round(accuracy)}m`;
    document.getElementById('last-sync').textContent = new Date().toLocaleTimeString();
    
    if (!myMarker) {
        myMarker = L.marker([lat, lng], { icon: myIcon }).addTo(map);
        if (followMe) map.setView([lat, lng], 17);
    } else {
        myMarker.setLatLng([lat, lng]);
        if (followMe) map.panTo([lat, lng]);
    }

    myPath.addLatLng([lat, lng]);
    const pPoints = myPath.getLatLngs();
    if (pPoints.length > MAX_PATH_POINTS) myPath.setLatLngs(pPoints.slice(1));
}

function flushOfflineBuffer() {
    if (offlineBuffer.length > 0) {
        offlineBuffer.forEach(data => { socket.emit('send-location', data); txCount++; });
        if (elTxCount) elTxCount.textContent = txCount;
        offlineBuffer.length = 0;
        showToast("Offline data synced!", "success");
    }
}

// --- 6. CLOUD LISTENERS (Laptop Mode) ---
socket.on('receive-location', (data) => {
    const { id, busName, lat, lng, speed, accuracy } = data;
    const unitTag = busName || id; // Prioritize Static ID

    // Prevent mirroring: Don't track ourselves as a "peer"
    if (unitTag === BUS_UNIT_ID) return;

    rxCount++; if (elRxCount) elRxCount.textContent = rxCount;
    if (!fleetUIElements[unitTag]) createFleetCard(unitTag);
    
    const ui = fleetUIElements[unitTag];
    ui.lat.textContent = lat.toFixed(5);
    ui.lng.textContent = lng.toFixed(5);
    
    if (lastEmittedPosition) {
        const d = calculateHaversine(lastEmittedPosition.lat, lastEmittedPosition.lng, lat, lng);
        ui.dist.textContent = d > 1000 ? (d/1000).toFixed(2) + 'km' : Math.round(d) + 'm';
    }

    if (!fleetMarkers[unitTag]) {
        fleetMarkers[unitTag] = L.marker([lat, lng], { icon: peerIcon }).addTo(map);
    } else {
        fleetMarkers[unitTag].setLatLng([lat, lng]);
    }

    if (!fleetPaths[unitTag]) {
        fleetPaths[unitTag] = L.polyline([], { color: '#4CAF50', weight: 4, opacity: 0.6, lineCap: 'round', lineJoin: 'round' }).addTo(map);
    }
    fleetPaths[unitTag].addLatLng([lat, lng]);
    const pPoints = fleetPaths[unitTag].getLatLngs();
    if (pPoints.length > MAX_PATH_POINTS) fleetPaths[unitTag].setLatLngs(pPoints.slice(1));
});

socket.on('unit-disconnected', (id) => {
    // In static mode, we don't immediately remove markers based on socket.id
    // to prevent flickering. markers stay until the app refreshes or a timeout.
});

function createFleetCard(id) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
        <h2 style="color:#4CAF50; margin-bottom:2px;"><i class="fa-solid fa-car-side"></i> Fleet Unit</h2>
        <div style="font-size:0.7rem; color:#888; margin-bottom:10px;">ID: ${id}</div>
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

// --- 7. UI TOGGLES ---
const btnFollow = document.getElementById('follow-toggle');
btnFollow.addEventListener('click', () => {
    followMe = !followMe;
    btnFollow.textContent = followMe ? "ON" : "OFF";
    btnFollow.style.background = followMe ? "#4CAF50" : "#888";
    if (followMe && lastEmittedPosition) {
        map.setView([lastEmittedPosition.lat, lastEmittedPosition.lng], 17);
    }
});

// --- 8. GEOLOCATION WATCHER ---
if ("geolocation" in navigator) {
    navigator.geolocation.watchPosition(
        (pos) => { handleLocationUpdate(pos.coords.latitude, pos.coords.longitude, pos.coords.speed, pos.coords.accuracy); },
        (err) => { console.error(err); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
}

document.getElementById('refresh-btn').addEventListener('click', () => window.location.reload());
document.getElementById('my-id').addEventListener('click', () => {
    navigator.clipboard.writeText(BUS_UNIT_ID);
    showToast("Unit ID copied!", "success");
});

document.getElementById('sidebar-header').addEventListener('click', () => {
    const content = document.getElementById('sidebar-content');
    const isHidden = content.style.display === 'none';
    content.style.display = isHidden ? 'flex' : 'none';
    document.getElementById('toggle-btn').querySelector('i').className = isHidden ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up';
});

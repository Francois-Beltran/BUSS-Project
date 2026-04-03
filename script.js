/**
 * BUSS TRACKER - CLOUD MIGRATION + STABILITY + TARGETED FOLLOWING
 * Refactored for Targeted Tracking & Trail Cleanup
 */

// --- 1. RANDOM IDENTITY ENGINE ---
const ADJECTIVES = ['Swift', 'Bold', 'Silent', 'Steel', 'Iron', 'Lunar', 'Turbo', 'Shadow', 'Azure', 'Crimson'];
const NOUNS = ['Falcon', 'Wolf', 'Raptor', 'Vanguard', 'Bear', 'Tiger', 'Phantom', 'Eagle', 'Nomad', 'Apex'];

function getPersistentIdentity() {
    let savedId = localStorage.getItem('BUSS_UNIT_ID');
    if (!savedId) {
        const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
        const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
        const num = Math.floor(Math.random() * 99) + 1;
        savedId = `${adj}-${noun}-${num.toString().padStart(2, '0')}`;
        localStorage.setItem('BUSS_UNIT_ID', savedId);
    }
    return savedId;
}

const BUS_UNIT_ID = getPersistentIdentity(); 
let followTarget = null; // Stores the Callsign we are following (if any)

// --- 2. TOAST NOTIFICATIONS ---
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? '<i class="fa-solid fa-circle-check" style="color:#4CAF50"></i>' : '<i class="fa-solid fa-triangle-exclamation" style="color:#f44336"></i>';
    toast.innerHTML = `${icon} <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => { if (container.contains(toast)) container.removeChild(toast); }, 4000);
}

// --- 3. MAP INITIALIZATION ---
let wakeLock = null;
const elWakeStatus = document.getElementById('wake-status');

async function requestWakeLock() {
    if ('wakeLock' in navigator && !wakeLock) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            if (elWakeStatus) { elWakeStatus.textContent = "Always On"; elWakeStatus.style.color = "#4CAF50"; }
        } catch (err) {}
    }
}

const map = L.map('map', { zoomControl: false }).setView([20, 0], 2);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', { attribution: '&copy; Google Maps', maxZoom: 20 }).addTo(map);

const myIcon = L.divIcon({ className: 'custom-marker', iconSize: [16, 16], iconAnchor: [8, 8] });
const peerIcon = L.divIcon({ className: 'peer-marker', iconSize: [16, 16], iconAnchor: [8, 8] });

let myMarker = null;
// Trails removed for a cleaner look as requested

const fleetMarkers = {}; 
const fleetUIElements = {}; 

// --- 4. CLOUD CONNECTION ---
const socket = io('https://buss-project.onrender.com');
const elStatus = document.getElementById('connection-status');
const elMyId = document.getElementById('my-id');
const peersContainer = document.getElementById('peers-container');

socket.on('connect', () => {
    elStatus.textContent = "Synced to Cloud";
    elStatus.style.color = "#4CAF50";
    elMyId.textContent = BUS_UNIT_ID;
    showToast(`Hello, ${BUS_UNIT_ID}!`, "success");
    requestWakeLock();
    flushOfflineBuffer();
});

socket.on('disconnect', () => {
    elStatus.textContent = "Offline (Buffering)";
    elStatus.style.color = "#FF5722";
});

// --- 5. SNAP-TO-ROAD (OSRM API) ---
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

// --- 6. SMOOTHING & TELEMETRY ---
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
        if (followTarget === BUS_UNIT_ID) map.setView([lat, lng], 17);
    } else {
        myMarker.setLatLng([lat, lng]);
        if (followTarget === BUS_UNIT_ID) map.panTo([lat, lng]);
    }
}

function flushOfflineBuffer() {
    if (offlineBuffer.length > 0) {
        offlineBuffer.forEach(data => { socket.emit('send-location', data); txCount++; });
        if (elTxCount) elTxCount.textContent = txCount;
        offlineBuffer.length = 0;
    }
}

// --- 7. CLOUD LISTENERS ---
socket.on('receive-location', (data) => {
    const { id, busName, lat, lng, speed, accuracy } = data;
    const unitTag = busName || id;

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

    // TARGETED PANNING logic
    if (unitTag === followTarget) {
        map.panTo([lat, lng]);
    }
});

socket.on('unit-disconnected', (id) => {
    // Graceful disconnect cleanup removed or made silent as requested in previous turn
});

function createFleetCard(id) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
        <h2 style="color:#4CAF50; margin-bottom:2px;"><i class="fa-solid fa-car-side"></i> Fleet Unit</h2>
        <div style="font-size:0.7rem; color:#888; margin-bottom:10px;">Callsign: ${id}</div>
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

// --- 8. UI HANDLERS ---
const followInput = document.getElementById('follow-input');
followInput.addEventListener('input', (e) => {
    followTarget = e.target.value.trim();
    if (followTarget) {
        console.log(`[Follow] Target set to: ${followTarget}`);
        // Immediately try to pan if the target exists
        if (followTarget === BUS_UNIT_ID && lastEmittedPosition) {
             map.panTo([lastEmittedPosition.lat, lastEmittedPosition.lng]);
        } else if (fleetMarkers[followTarget]) {
             map.panTo(fleetMarkers[followTarget].getLatLng());
        }
    }
});

// --- 9. GEOLOCATION WATCHER ---
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
    showToast("Identity copied!", "success");
});

document.getElementById('sidebar-header').addEventListener('click', () => {
    const content = document.getElementById('sidebar-content');
    const isHidden = content.style.display === 'none';
    content.style.display = isHidden ? 'flex' : 'none';
    document.getElementById('toggle-btn').querySelector('i').className = isHidden ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up';
});

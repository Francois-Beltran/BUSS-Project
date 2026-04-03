/**
 * BUSS TRACKER - CLOUD MIGRATION + LERP + PWA + BACKGROUND PERSISTENCE
 * Refactored for Continuous tracking while screen is locked.
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
let followTarget = null; 

// --- 2. BACKGROUND PERSISTENCE (Silent Audio & Locks) ---
let audioContext = null;
let silentBuffer = null;

function startSilentAudio() {
    if (audioContext) return;
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        silentBuffer = audioContext.createBuffer(1, 1, 22050); 
        
        function playSilence() {
            const source = audioContext.createBufferSource();
            source.buffer = silentBuffer;
            source.connect(audioContext.destination);
            source.onended = playSilence; 
            source.start(0);
        }
        playSilence();
        console.log("[BUSS] Silent Audio Heartbeat Started");
    } catch (e) { console.error("[BUSS] AudioContext Error:", e); }
}

async function requestBackgroundPersistence() {
    // 1. Wake Lock (Screen)
    requestWakeLock();

    // 2. Web Locks API (System/CPU)
    if ('locks' in navigator) {
        navigator.locks.request('buss_background_sync', { ifAvailable: true }, async (lock) => {
            if (lock) {
                console.log("[BUSS] System CPU Lock Acquired");
                // Keep the lock held as long as the app is running
                await new Promise(() => {}); 
            }
        });
    }

    // 3. Automation on Interaction
    window.addEventListener('click', () => {
        startSilentAudio();
        if (audioContext && audioContext.state === 'suspended') audioContext.resume();
    }, { once: true });
}

// UI State for Background Mode
document.addEventListener('visibilitychange', () => {
    const elWakeStatus = document.getElementById('wake-status');
    if (document.hidden) {
        if (elWakeStatus) {
            elWakeStatus.textContent = "Background Mode Active";
            elWakeStatus.style.color = "#4CAF50";
        }
        console.log("[BUSS] App in Pocket - Persistence Active");
    } else {
        if (elWakeStatus && wakeLock) {
            elWakeStatus.textContent = "Always On";
            elWakeStatus.style.color = "#4CAF50";
        }
    }
});

// --- 3. SMOOTH ANIMATION (LERP) ---
function animateMarkerTo(marker, targetLat, targetLng, duration = 1000) {
    const startLat = marker.getLatLng().lat;
    const startLng = marker.getLatLng().lng;
    const startTime = performance.now();

    function step(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const currentLat = startLat + (targetLat - startLat) * progress;
        const currentLng = startLng + (targetLng - startLng) * progress;
        marker.setLatLng([currentLat, currentLng]);
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

// --- 4. TOAST NOTIFICATIONS ---
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? '<i class="fa-solid fa-circle-check" style="color:#4CAF50"></i>' : '<i class="fa-solid fa-triangle-exclamation" style="color:#f44336"></i>';
    toast.innerHTML = `${icon} <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => { if (container.contains(toast)) container.removeChild(toast); }, 4000);
}

// --- 5. MAP INITIALIZATION ---
let wakeLock = null;
async function requestWakeLock() {
    if ('wakeLock' in navigator && !wakeLock) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            const elWakeStatus = document.getElementById('wake-status');
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
const fleetMarkers = {}; 
const fleetUIElements = {}; 

// --- 6. CLOUD CONNECTION (Optimized for Background) ---
const socket = io('https://buss-project.onrender.com', {
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: Infinity
});

const elStatus = document.getElementById('connection-status');
const elMyId = document.getElementById('my-id');
const peersContainer = document.getElementById('peers-container');

socket.on('connect', () => {
    elStatus.textContent = "Synced to Cloud";
    elStatus.style.color = "#4CAF50";
    elMyId.textContent = BUS_UNIT_ID;
    showToast(`Hello, ${BUS_UNIT_ID}!`, "success");
    requestBackgroundPersistence(); // Start automation on connect
    flushOfflineBuffer();
});

socket.on('disconnect', () => {
    elStatus.textContent = "Offline (Buffering)";
    elStatus.style.color = "#FF5722";
});

// --- 7. SNAP-TO-ROAD (OSRM API) ---
async function fetchSnappedLocation(lat, lng) {
    try {
        const response = await fetch(`https://router.project-osrm.org/nearest/v1/driving/${lng},${lat}?number=1`);
        const data = await response.json();
        if (data.code === 'Ok' && data.waypoints?.length > 0) {
            return { lat: data.waypoints[0].location[1], lng: data.waypoints[0].location[0] };
        }
    } catch (e) {}
    return { lat, lng };
}

// --- 8. SMOOTHING & TELEMETRY ---
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
    const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getSmoothedCoords(buffer) {
    if (!buffer.length) return null;
    let l = buffer.length, lat = 0, lng = 0, acc = 0;
    buffer.forEach(p => { lat += p.lat; lng += p.lng; acc += p.accuracy; });
    return { lat: lat / l, lng: lng / l, accuracy: acc / l };
}

async function handleLocationUpdate(lat, lng, speed, accuracy) {
    if (accuracy > ACCURACY_THRESHOLD) return;
    localSmoothingBuffer.push({ lat, lng, accuracy });
    if (localSmoothingBuffer.length > 5) localSmoothingBuffer.shift();
    const smoothed = getSmoothedCoords(localSmoothingBuffer);
    if (!smoothed) return;

    const snapped = await fetchSnappedLocation(smoothed.lat, smoothed.lng);
    if (lastEmittedPosition) {
        if (calculateHaversine(lastEmittedPosition.lat, lastEmittedPosition.lng, snapped.lat, snapped.lng) < DISTANCE_THRESHOLD) return;
    }

    updateLocalUI(snapped.lat, snapped.lng, speed, smoothed.accuracy);
    
    const payload = { busName: BUS_UNIT_ID, lat: snapped.lat, lng: snapped.lng, speed, accuracy: smoothed.accuracy, timestamp: Date.now() };

    if (socket.connected) {
        socket.emit('send-location', payload, () => {
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
        animateMarkerTo(myMarker, lat, lng, 1000);
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

// --- 9. CLOUD LISTENERS ---
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
        animateMarkerTo(fleetMarkers[unitTag], lat, lng, 1000);
    }

    if (unitTag === followTarget) map.panTo([lat, lng]);
});

socket.on('unit-disconnected', (id) => { /* Silent cleanup handles jitter */ });

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
    fleetUIElements[id] = { card, lat: document.getElementById(`lat-${id}`), lng: document.getElementById(`lng-${id}`), dist: document.getElementById(`dist-${id}`) };
}

// --- 10. UI HANDLERS ---
const followInput = document.getElementById('follow-input');
if (followInput) {
    followInput.addEventListener('input', (e) => {
        followTarget = e.target.value.trim();
        if (followTarget && fleetMarkers[followTarget]) map.panTo(fleetMarkers[followTarget].getLatLng());
    });
}

// --- 11. GEOLOCATION WATCHER (High Priority) ---
if ("geolocation" in navigator) {
    navigator.geolocation.watchPosition(
        (pos) => { handleLocationUpdate(pos.coords.latitude, pos.coords.longitude, pos.coords.speed, pos.coords.accuracy); },
        (err) => { console.error(err); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
    );
}

document.getElementById('refresh-btn').addEventListener('click', () => window.location.reload());
document.getElementById('my-id').addEventListener('click', () => { navigator.clipboard.writeText(BUS_UNIT_ID); showToast("Identity copied!", "success"); });
document.getElementById('sidebar-header').addEventListener('click', () => {
    const content = document.getElementById('sidebar-content');
    const isHidden = content.style.display === 'none';
    content.style.display = isHidden ? 'flex' : 'none';
    document.getElementById('toggle-btn').querySelector('i').className = isHidden ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up';
});

// PWA Service Worker Registration
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(() => console.log('[BUSS] Service Worker Registered'));
}

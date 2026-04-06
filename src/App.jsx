import React, { useEffect, useRef, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { Navigation, Map as MapIcon, Search, X, MapPin, AlertTriangle, WifiOff } from 'lucide-react';

// ==========================================
// 1. KONFIGURATION & HILFSFUNKTIONEN
// ==========================================
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

const getDistance = (lon1, lat1, lon2, lat2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Toast-ID-Zähler außerhalb der Komponente, damit er stabil bleibt
let toastIdCounter = 0;

// ==========================================
// 2. HAUPT-KOMPONENTE
// ==========================================
const App = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const playerMarker = useRef(null);
  const destinationMarker = useRef(null);
  const waypointMarkers = useRef([]);
  const searchAbortController = useRef(null);

  // ----------------------------------------
  // FIX 6: Refs als einzige Quelle der Wahrheit für GPS-Koordinaten.
  // Früher liefen currentLngRef/currentLatRef parallel zu lng/lat-State
  // und konnten desynchronisiert werden. Jetzt sind die Refs die primäre
  // Quelle – alle Handler lesen daraus. Der State entfällt komplett.
  // ----------------------------------------
  const currentLngRef = useRef(13.4050);
  const currentLatRef = useRef(52.5200);

  const [speed, setSpeed] = useState(0);
  const [time, setTime] = useState(new Date().toLocaleTimeString('de-DE', { hour12: false }));

  const [isWorldMap, setIsWorldMap] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isCalculating, setIsCalculating] = useState(false);

  const [destination, setDestination] = useState(null);
  const [waypoints, setWaypoints] = useState([]);
  const [eta, setEta] = useState(null);
  const [showFinishScreen, setShowFinishScreen] = useState(false);

  // ----------------------------------------
  // FIX 5: GPS-Status als State ('pending' | 'active' | 'denied' | 'unavailable')
  // ----------------------------------------
  const [gpsStatus, setGpsStatus] = useState('pending');

  // ----------------------------------------
  // FIX 4: Toast-Benachrichtigungs-System für sichtbare Fehlermeldungen
  // ----------------------------------------
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'error') => {
    const id = ++toastIdCounter;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4500);
  }, []);

  // --- UHRZEIT TICK ---
  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date().toLocaleTimeString('de-DE', { hour12: false }));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // --- MAPBOX INITIALISIEREN ---
  useEffect(() => {
    if (map.current) return;
    mapboxgl.accessToken = MAPBOX_TOKEN;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/navigation-night-v1',
      center: [currentLngRef.current, currentLatRef.current],
      zoom: 16,
      pitch: 60,
      bearing: 0,
      antialias: true,
      interactive: false
    });

    const el = document.createElement('div');
    el.innerHTML = `
      <svg viewBox="0 0 24 24" width="36" height="36" style="filter: drop-shadow(0 0 12px rgba(0,242,255,1));">
        <path d="M12 2L3 20l9-4 9 4z" fill="#00f2ff" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
    `;

    playerMarker.current = new mapboxgl.Marker({
      element: el,
      rotationAlignment: 'map',
      pitchAlignment: 'map'
    })
      .setLngLat([currentLngRef.current, currentLatRef.current])
      .addTo(map.current);
  }, []);

  // --- ROUTE BERECHNEN (INTELLIGENTES PROFIL) ---
  const calculateRoute = useCallback(async (currentLng, currentLat, destCoords, wpCoordsList = []) => {
    if (!destCoords) return;
    setIsCalculating(true);

    const allCoords = [[currentLng, currentLat], ...wpCoordsList, destCoords];
    const coordsString = allCoords.map(c => `${c[0]},${c[1]}`).join(';');

    // LOGIK-WEICHE: driving-traffic erlaubt maximal 3 Koordinaten insgesamt.
    const profile = allCoords.length <= 3 ? 'driving-traffic' : 'driving';

    // FIX 4: AbortController für 10-Sekunden-Timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(
        `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coordsString}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`,
        { signal: controller.signal }
      );
      clearTimeout(timeout);

      // FIX 4: HTTP-Fehler sichtbar machen
      if (!response.ok) {
        throw new Error(`Server-Fehler ${response.status}`);
      }

      const data = await response.json();

      if (data.routes && data.routes.length > 0) {
        const route = data.routes[0].geometry;
        const durationSeconds = data.routes[0].duration;
        setEta(Math.ceil(durationSeconds / 60));

        if (map.current.getSource('route')) {
          map.current.getSource('route').setData(route);
        } else {
          map.current.addLayer({
            id: 'route-glow', type: 'line', source: { type: 'geojson', data: route },
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#00f2ff', 'line-width': 18, 'line-blur': 10, 'line-opacity': 0.8 }
          });
          map.current.addLayer({
            id: 'route', type: 'line', source: { type: 'geojson', data: route },
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#88ffff', 'line-width': 4, 'line-opacity': 1 }
          });
        }
      } else {
        // FIX 4: Leere Routen-Antwort dem Nutzer anzeigen
        addToast('Keine Route gefunden. Bitte Ziel oder Startpunkt ändern.', 'info');
      }
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        // FIX 4: Timeout sichtbar machen
        addToast('Routenberechnung: Zeitüberschreitung. Netzwerk prüfen.');
      } else {
        console.error('Fehler bei der Routenberechnung:', error);
        addToast('Routenberechnung fehlgeschlagen. Erneut versuchen.');
      }
    }

    setIsCalculating(false);
  }, [addToast]);

  // --- LIVE-REROUTING SCHLEIFE (ALLE 60 SEKUNDEN) ---
  useEffect(() => {
    if (!destination) return;
    const interval = setInterval(() => {
      // FIX 6: Refs statt State – immer aktuelle Position, kein Stale-Closure-Risiko
      calculateRoute(currentLngRef.current, currentLatRef.current, destination, waypoints);
    }, 60000);
    return () => clearInterval(interval);
  }, [destination, waypoints, calculateRoute]);

  // --- GPS TRACKING & GEOFENCING ---
  useEffect(() => {
    // FIX 5: Kein navigator.geolocation → klar sichtbare Fehlermeldung
    if (!navigator.geolocation) {
      setGpsStatus('unavailable');
      addToast('GPS nicht verfügbar. Standortzugriff wird nicht unterstützt.');
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const newLng = position.coords.longitude;
        const newLat = position.coords.latitude;
        const newSpeed = position.coords.speed ? (position.coords.speed * 3.6).toFixed(0) : 0;
        const currentHeading = position.coords.heading;

        // FIX 6: Refs als primäre Quelle aktualisieren – kein paralleler State mehr
        currentLngRef.current = newLng;
        currentLatRef.current = newLat;

        setSpeed(newSpeed);
        setGpsStatus('active');

        if (playerMarker.current) {
          playerMarker.current.setLngLat([newLng, newLat]);
          if (currentHeading !== null) {
            playerMarker.current.setRotation(currentHeading);
          }
        }

        if (map.current && !isWorldMap) {
          map.current.easeTo({ center: [newLng, newLat], bearing: currentHeading || 0, duration: 1000 });
        }

        // GEOFENCING: Zwischenstopps (< 50m)
        if (waypoints.length > 0) {
          const nextWp = waypoints[0];
          if (getDistance(newLng, newLat, nextWp[0], nextWp[1]) < 0.05) {
            const remainingWps = waypoints.slice(1);
            setWaypoints(remainingWps);

            if (waypointMarkers.current[0]) {
              waypointMarkers.current[0].remove();
              waypointMarkers.current.shift();
            }
            calculateRoute(newLng, newLat, destination, remainingWps);
          }
        }

        // GEOFENCING: Endziel (< 30m)
        if (destination && waypoints.length === 0 && !showFinishScreen) {
          if (getDistance(newLng, newLat, destination[0], destination[1]) < 0.03) {
            setShowFinishScreen(true);
            setTimeout(() => {
              setShowFinishScreen(false);
              handleCancelRoute();
            }, 5000);
          }
        }
      },
      // FIX 5: GPS-Fehler mit Fehlercode differenzieren und dem Nutzer anzeigen
      (error) => {
        console.error('GPS Fehler:', error);
        if (error.code === error.PERMISSION_DENIED) {
          setGpsStatus('denied');
          addToast('GPS-Zugriff verweigert – Standortberechtigung in den Browser-Einstellungen aktivieren.');
        } else if (error.code === error.POSITION_UNAVAILABLE) {
          setGpsStatus('unavailable');
          addToast('Standort nicht verfügbar – GPS-Signal prüfen.');
        } else if (error.code === error.TIMEOUT) {
          addToast('GPS-Signal: Zeitüberschreitung. Wird weiter versucht...');
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [isWorldMap, destination, waypoints, showFinishScreen, calculateRoute, addToast]);

  // --- KAMERA-FLUG ANIMATIONS-FIX ---
  useEffect(() => {
    if (!map.current) return;
    let startTimestamp = null;
    let animationFrameId;

    const animateResize = (timestamp) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = timestamp - startTimestamp;
      if (map.current) map.current.resize();
      if (progress < 1200) animationFrameId = window.requestAnimationFrame(animateResize);
    };

    animationFrameId = window.requestAnimationFrame(animateResize);

    if (isWorldMap) {
      map.current.flyTo({ zoom: 12, pitch: 0, bearing: 0, duration: 1500 });
      map.current.dragPan.enable();
      map.current.scrollZoom.enable();
    } else {
      const currentRotation = playerMarker.current ? playerMarker.current.getRotation() : 0;
      // FIX 6: Refs statt State für aktuelle Position bei Kameraflug
      map.current.flyTo({ center: [currentLngRef.current, currentLatRef.current], zoom: 16, pitch: 60, bearing: currentRotation, duration: 1500 });
      map.current.dragPan.disable();
      map.current.scrollZoom.disable();
    }

    return () => { if (animationFrameId) window.cancelAnimationFrame(animationFrameId); };
  }, [isWorldMap]);

  // --- ORTSSUCHE ---
  const handleSearch = useCallback(async (e) => {
    const query = e.target.value;
    setSearchQuery(query);

    if (query.length > 2) {
      // FIX 4: Vorherige laufende Anfrage abbrechen (verhindert Race Conditions)
      if (searchAbortController.current) {
        searchAbortController.current.abort();
      }
      searchAbortController.current = new AbortController();
      const timeout = setTimeout(() => searchAbortController.current?.abort(), 8000);

      try {
        // FIX 6: Refs statt State für Proximity-Bias in der Suche
        const response = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?proximity=${currentLngRef.current},${currentLatRef.current}&access_token=${MAPBOX_TOKEN}&limit=5`,
          { signal: searchAbortController.current.signal }
        );
        clearTimeout(timeout);

        // FIX 4: HTTP-Fehler sichtbar machen
        if (!response.ok) throw new Error(`Server-Fehler ${response.status}`);

        const data = await response.json();
        setSearchResults(data.features || []);

        if ((data.features || []).length === 0) {
          addToast('Keine Ergebnisse gefunden. Suchbegriff anpassen.', 'info');
        }
      } catch (error) {
        clearTimeout(timeout);
        if (error.name !== 'AbortError') {
          // FIX 4: Netzwerkfehler dem Nutzer anzeigen
          console.error('Fehler bei der Ortssuche:', error);
          setSearchResults([]);
          addToast('Suche fehlgeschlagen – Netzwerkverbindung prüfen.');
        }
      }
    } else {
      setSearchResults([]);
    }
  }, [addToast]);

  // --- SETZE ENDZIEL ---
  const handleSetDestination = (feature) => {
    setIsSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);

    const destCoords = feature.center;
    setDestination(destCoords);

    if (destinationMarker.current) destinationMarker.current.remove();
    const destEl = document.createElement('div');
    destEl.className = 'w-8 h-8 bg-red-600 rounded-full border-2 border-white shadow-[0_0_15px_rgba(255,0,0,0.8)] flex items-center justify-center';
    destEl.innerHTML = '<div class="w-3 h-3 bg-white rounded-full"></div>';

    destinationMarker.current = new mapboxgl.Marker({ element: destEl }).setLngLat(destCoords).addTo(map.current);

    // FIX 6: Refs statt stale State – garantiert aktuelle Position
    calculateRoute(currentLngRef.current, currentLatRef.current, destCoords, waypoints);
  };

  // --- SETZE ZWISCHENSTOPP ---
  const handleSetWaypoint = (feature) => {
    setIsSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);

    const wpCoords = feature.center;
    const newWaypoints = [...waypoints, wpCoords];
    setWaypoints(newWaypoints);

    const wpEl = document.createElement('div');
    wpEl.className = 'w-8 h-8 bg-yellow-400 rounded-full border-2 border-white shadow-[0_0_15px_rgba(250,204,21,0.8)] flex items-center justify-center text-black font-bold text-sm';
    wpEl.innerHTML = newWaypoints.length;

    const marker = new mapboxgl.Marker({ element: wpEl }).setLngLat(wpCoords).addTo(map.current);
    waypointMarkers.current.push(marker);

    if (destination) {
      // FIX 6: Refs statt stale State
      calculateRoute(currentLngRef.current, currentLatRef.current, destination, newWaypoints);
    }
  };

  // --- ROUTE MANUELL ABBRECHEN ---
  const handleCancelRoute = () => {
    if (destinationMarker.current) destinationMarker.current.remove();
    destinationMarker.current = null;

    waypointMarkers.current.forEach(marker => marker.remove());
    waypointMarkers.current = [];

    if (map.current.getSource('route')) {
      if (map.current.getLayer('route')) map.current.removeLayer('route');
      if (map.current.getLayer('route-glow')) map.current.removeLayer('route-glow');
      map.current.removeSource('route');
    }

    setDestination(null);
    setWaypoints([]);
    setEta(null);
  };

  return (
    <div className="relative w-screen h-screen bg-nfsDark overflow-hidden font-mono text-nfsBlue">

      {/* FIX 4: TOAST BENACHRICHTIGUNGEN */}
      <div className="absolute top-6 left-1/2 -translate-x-1/2 z-[200] flex flex-col gap-2 items-center pointer-events-none w-max max-w-[90vw]">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`px-4 py-2 rounded-sm border font-bold text-sm tracking-wider backdrop-blur-md shadow-lg
              ${toast.type === 'info'
                ? 'bg-black/80 border-nfsBlue/60 text-nfsBlue shadow-[0_0_10px_rgba(0,242,255,0.3)]'
                : 'bg-black/80 border-red-500/60 text-red-400 shadow-[0_0_10px_rgba(255,0,0,0.3)]'
              }`}
            role="alert"
          >
            <AlertTriangle size={14} className="inline mr-2" />
            {toast.message}
          </div>
        ))}
      </div>

      {/* FIX 5: GPS STATUS BANNER */}
      {(gpsStatus === 'denied' || gpsStatus === 'unavailable') && (
        <div className="absolute top-0 left-0 right-0 z-[150] flex items-center justify-center gap-3 px-4 py-2 bg-red-900/80 border-b border-red-500/60 backdrop-blur-sm text-red-300 text-sm font-bold tracking-wide" role="status">
          <WifiOff size={16} />
          {gpsStatus === 'denied'
            ? 'GPS-ZUGRIFF VERWEIGERT — Standortberechtigung in Browser-Einstellungen aktivieren'
            : 'GPS NICHT VERFÜGBAR — Kein Standortsignal'
          }
        </div>
      )}

      {/* TACHO & ETA */}
      <div className="absolute top-6 right-6 z-10 text-right pointer-events-none flex flex-col items-end">
        <div className="text-5xl font-black italic tracking-tighter drop-shadow-[0_0_15px_rgba(0,242,255,0.8)]">
          {speed} <span className="text-xl">KM/H</span>
        </div>
        {eta && (
          <div className="mt-2 px-3 py-1 bg-black/60 border border-nfsBlue/40 text-nfsBlue font-bold tracking-widest rounded-sm shadow-[0_0_10px_rgba(0,242,255,0.2)]">
            ETA: {eta} MIN
          </div>
        )}
      </div>

      {/* KARTEN CONTAINER */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-4">
        <div
          className="pointer-events-auto transition-all duration-1000 ease-in-out border-4 border-nfsBlue shadow-[0_0_20px_rgba(0,242,255,0.5)] overflow-hidden bg-nfsDark"
          style={{
            width: isWorldMap ? '95%' : '320px',
            height: isWorldMap ? '85%' : '320px',
            borderRadius: isWorldMap ? '1rem' : '50%',
            WebkitMaskImage: '-webkit-radial-gradient(white, black)'
          }}
        >
          <div ref={mapContainer} className="w-full h-full" style={{ borderRadius: 'inherit' }} />
        </div>
      </div>

      {/* UHRZEIT */}
      <div className="absolute bottom-6 left-6 z-10 pointer-events-none">
        <div className="bg-nfsDark/20 p-1 rounded-sm border-2 border-nfsBlue/30 shadow-[0_0_8px_rgba(0,242,255,0.1)] backdrop-blur-sm">
          <span className="text-2xl font-black tracking-widest drop-shadow-[0_0_10px_rgba(0,242,255,1)]">
            {time}
          </span>
        </div>
      </div>

      {/* MENÜ & ABBRUCH-BUTTON */}
      <div className="absolute bottom-6 right-6 z-10 flex gap-4">
        {(destination || waypoints.length > 0) && (
          <button
            onClick={handleCancelRoute}
            aria-label="Route abbrechen"
            className="p-4 bg-red-600/90 border-2 border-white rounded-full shadow-[0_0_15px_rgba(255,0,0,0.8)] hover:bg-red-500 hover:scale-110 transition-all text-white"
          >
            <X size={28} />
          </button>
        )}

        <button
          onClick={() => setIsSearchOpen(true)}
          aria-label="Ziel suchen"
          className="p-4 bg-black/80 border-2 border-nfsBlue rounded-full shadow-[0_0_15px_rgba(0,242,255,0.4)] hover:bg-nfsBlue hover:text-black hover:scale-105 transition-all"
        >
          <Navigation size={28} />
        </button>
        <button
          aria-label={isWorldMap ? 'Navigationsansicht' : 'Kartenübersicht'}
          className={`p-4 border-2 border-nfsBlue rounded-full transition-all shadow-[0_0_15px_rgba(0,242,255,0.4)] hover:scale-105 ${
            isWorldMap ? 'bg-nfsBlue text-black shadow-[0_0_25px_rgba(0,242,255,0.8)]' : 'bg-black/80 text-nfsBlue hover:bg-nfsBlue hover:text-black'
          }`}
          onClick={() => setIsWorldMap(!isWorldMap)}
        >
          <MapIcon size={28} />
        </button>
      </div>

      {/* FINISH SCREEN */}
      {showFinishScreen && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md transition-opacity">
          <div className="text-center animate-pulse">
            <div className="text-5xl sm:text-7xl font-black italic text-nfsBlue drop-shadow-[0_0_20px_rgba(0,242,255,1)] mb-4">
              DESTINATION REACHED
            </div>
            <div className="text-2xl sm:text-3xl text-white tracking-widest uppercase font-bold">
              Mission Accomplished
            </div>
          </div>
        </div>
      )}

      {/* SUCHE */}
      {isSearchOpen && (
        <div
          className="absolute inset-0 z-50 flex flex-col items-center justify-start pt-20 bg-black/90 backdrop-blur-md p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Zielsuche"
        >
          <button
            onClick={() => setIsSearchOpen(false)}
            aria-label="Suche schließen"
            className="absolute top-6 right-6 text-nfsBlue hover:text-white transition-colors"
          >
            <X size={40} />
          </button>

          <h2 className="text-3xl font-black italic tracking-widest mb-8 drop-shadow-[0_0_10px_rgba(0,242,255,0.8)]">ENTER DESTINATION</h2>

          <div className="w-full max-w-md relative">
            <Search className="absolute left-4 top-4 text-nfsBlue/50" size={24} aria-hidden="true" />
            <input
              type="text"
              value={searchQuery}
              onChange={handleSearch}
              placeholder="Search address, POI..."
              aria-label="Ziel eingeben"
              className="w-full bg-black border-2 border-nfsBlue text-white p-4 pl-14 text-xl rounded-none outline-none focus:shadow-[0_0_20px_rgba(0,242,255,0.6)] transition-shadow placeholder-nfsBlue/30 font-bold tracking-wider uppercase"
              autoFocus
            />
          </div>

          <div className="w-full max-w-md mt-4 max-h-[50vh] overflow-y-auto custom-scrollbar" role="list">
            {searchResults?.map((result) => (
              <div key={result.id} className="w-full flex flex-col gap-3 p-4 border-b border-nfsBlue/30 bg-black/40 hover:bg-nfsBlue/10 transition-colors group" role="listitem">
                <div className="flex items-center gap-4 text-left">
                  <MapPin className="text-nfsBlue group-hover:scale-110 transition-transform" size={24} aria-hidden="true" />
                  <div className="flex-1">
                    <div className="font-bold text-white text-lg">{result.text}</div>
                    <div className="text-sm text-nfsBlue/70">{result.place_name.substring(0, 50)}...</div>
                  </div>
                </div>
                <div className="flex gap-2 mt-1">
                  <button onClick={() => handleSetDestination(result)} className="flex-1 bg-nfsBlue/20 hover:bg-nfsBlue text-nfsBlue hover:text-black border border-nfsBlue p-2 font-bold text-sm transition-colors">
                    GO HERE
                  </button>
                  <button onClick={() => handleSetWaypoint(result)} className="flex-1 bg-yellow-400/10 hover:bg-yellow-400 text-yellow-400 hover:text-black border border-yellow-400 p-2 font-bold text-sm transition-colors">
                    + ADD STOP
                  </button>
                </div>
              </div>
            ))}
            {isCalculating && (
              <div className="text-center mt-8 text-xl animate-pulse" role="status" aria-live="polite">CALCULATING ROUTE...</div>
            )}
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.1)_50%),linear-gradient(90deg,rgba(255,0,0,0.02),rgba(0,255,0,0.01),rgba(0,0,255,0.02))] bg-[length:100%_4px,3px_100%] opacity-70" />
    </div>
  );
};

export default App;

// Deterministic transport fixture; no network, provider or semantic document.
self.onmessage = event => { if (event.data !== 'stall') self.postMessage({invalid:true}); };

// ── firebase.js ───────────────────────────────────────────────────────────────
// Firebase init + all read/write helpers
// Exposes: window.fbSave, window.fbLoad, window.fbListen, window.fbSafeSave
// ─────────────────────────────────────────────────────────────────────────────

function initFirebase(){
  if(typeof firebase === "undefined"){
    setTimeout(initFirebase, 100); // wait for compat scripts to load
    return;
  }
  (function(){
    const firebaseConfig = {
      apiKey: "AIzaSyCSIreDUpNhSBbZECWoOulV18R5yVlHOAE",
      authDomain: "confluence-screener.firebaseapp.com",
      databaseURL: "https://confluence-screener-default-rtdb.firebaseio.com",
      projectId: "confluence-screener",
      storageBucket: "confluence-screener.firebasestorage.app",
      messagingSenderId: "8400711645",
      appId: "1:8400711645:web:f2a1fee50a20e487c31034"
    };

    const app = firebase.initializeApp(firebaseConfig);
    const db  = firebase.database();

    window.fbSave = async function(key, data){
      try{
        await db.ref("screener/"+key).set({
          data: JSON.stringify(data),
          savedAt: new Date().toISOString(),
          device: navigator.userAgent.includes("Mobile") ? "mobile" : "desktop"
        });
        return true;
      }catch(e){ console.warn("fbSave failed:", e); return false; }
    };

    window.fbLoad = async function(key){
      try{
        const snap = await db.ref("screener/"+key).once("value");
        if(snap.exists()){
          const val = snap.val();
          let data = val.data;
          if(typeof data === "string"){
            // Strip markdown backticks if present
            data = data.replace(/```json|```/g, "").trim();
            try{ data = JSON.parse(data); }catch(e){ data = val.data; }
          }
          return { data, savedAt: val.savedAt, device: val.device };
        }
        return null;
      }catch(e){ console.warn("fbLoad failed:", e); return null; }
    };

    window.fbListen = function(key, callback){
      db.ref("screener/"+key).on("value", (snap)=>{
        if(snap.exists()){
          try{
            const val = snap.val();
            callback({ data: typeof val.data==="string"?JSON.parse(val.data):val.data, savedAt: val.savedAt, device: val.device });
          }catch(e){}
        }
      });
    };

    window.firebaseReady = true;
    document.dispatchEvent(new Event("firebaseReady"));
    console.log("Firebase ✅ connected (compat)");

    setTimeout(()=>{
      const el = document.getElementById("fbStatus");
      if(el){
        el.textContent = "🟢 FIREBASE";
        el.style.background = "rgba(0,200,83,0.1)";
        el.style.color = "#00C853";
        el.style.borderColor = "rgba(0,200,83,0.3)";
        const el2 = document.getElementById("fbStatus2");
        if(el2){ el2.textContent="🟢 FIREBASE"; el2.style.color="#00C853"; el2.style.borderColor="rgba(0,200,83,0.3)"; }
      }
    }, 500);
  })();
}

function fbSafeSave(key, data){
  if(window.firebaseReady){
    window.fbSave(key, data);
  } else {
    document.addEventListener("firebaseReady", ()=>window.fbSave(key, data), {once:true});
  }
}

// Auto-init on load
if(document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", initFirebase);
} else {
  initFirebase();
}

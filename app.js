
(() => {
  const $ = id => document.getElementById(id);
  const marksByCode = new Map(window.SOLENT_MARKS.map(m => [m.code, m]));
  let course = [];
  let currentLeg = 0;
  let watchId = null;
  let lastPosition = null;
  let deferredInstall = null;
  let wakeLock = null;
  let insideRadius = false;

  const stateKey = "solentCourse.saved.v1";

  function normaliseTokens(text) {
    return text.toUpperCase()
      .replace(/[–—]/g, "-")
      .split(/[\s,;>\-]+/)
      .map(x => x.trim())
      .filter(Boolean);
  }

  function parseToken(token) {
    const match = token.match(/^([1-9][A-Z0-9])(?:\(([PS])\)|\/([PS]))?$/);
    if (!match) return { error: token };
    return { code: match[1], rounding: match[2] || match[3] || $("defaultRounding").value };
  }

  function buildCourse() {
    const tokens = normaliseTokens($("courseInput").value);
    const errors = [];
    const parsed = [];
    for (const token of tokens) {
      const part = parseToken(token);
      if (part.error) { errors.push(`${token} is not a valid code`); continue; }
      const mark = marksByCode.get(part.code);
      if (!mark) { errors.push(`${part.code} is not in the 2026 database`); continue; }
      parsed.push({ ...mark, rounding: part.rounding });
    }
    course = parsed;
    renderCourse();
    if (errors.length) showMessage(errors.join(" · "), "error");
    else if (course.length) showMessage(`${course.length} marks loaded`, "success");
    else showMessage("Enter at least one mark code", "error");
  }

  function renderCourse() {
    const list = $("courseList");
    list.innerHTML = "";
    course.forEach((leg, i) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="code">${leg.code}</span>
        <span class="name">${escapeHtml(leg.name)}</span>
        <select aria-label="Rounding for ${leg.code}">
          <option value="" ${!leg.rounding ? "selected" : ""}>None</option>
          <option value="P" ${leg.rounding === "P" ? "selected" : ""}>Port</option>
          <option value="S" ${leg.rounding === "S" ? "selected" : ""}>Starboard</option>
        </select>
        <button aria-label="Remove ${leg.code}">×</button>`;
      li.querySelector("select").addEventListener("change", e => course[i].rounding = e.target.value);
      li.querySelector("button").addEventListener("click", () => {
        course.splice(i, 1);
        renderCourse();
      });
      list.appendChild(li);
    });
    $("startBtn").disabled = !course.length;
    $("saveBtn").disabled = !course.length;
  }

  function showMessage(text, cls) {
    $("messages").textContent = text;
    $("messages").className = cls || "";
  }

  function escapeHtml(text) {
    return text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function startCourse() {
    if (!course.length) return;
    currentLeg = 0;
    insideRadius = false;
    $("setupView").classList.add("hidden");
    $("raceView").classList.remove("hidden");
    updateRaceDisplay();
    startGps();
  }

  function updateRaceDisplay() {
    const mark = course[currentLeg];
    if (!mark) return finishCourse();
    $("nextCode").textContent = mark.code;
    $("nextName").textContent = mark.name;
    $("roundingBadge").textContent = mark.rounding === "P" ? "ROUND TO PORT" :
      mark.rounding === "S" ? "ROUND TO STARBOARD" : "ROUNDING UNSPECIFIED";
    $("legCounter").textContent = `Leg ${currentLeg + 1} of ${course.length}`;
    $("prevBtn").disabled = currentLeg === 0;
    $("nextBtn").textContent = currentLeg === course.length - 1 ? "Finish ▶" : "Next mark ▶";
    if (lastPosition) updateNavigation(lastPosition);
  }

  function nextLeg() {
    if (currentLeg < course.length - 1) {
      currentLeg++;
      insideRadius = false;
      updateRaceDisplay();
      navigator.vibrate?.(80);
    } else {
      finishCourse();
    }
  }

  function previousLeg() {
    if (currentLeg > 0) {
      currentLeg--;
      insideRadius = false;
      updateRaceDisplay();
    }
  }

  function finishCourse() {
    stopGps();
    alert("Course complete");
    $("raceView").classList.add("hidden");
    $("setupView").classList.remove("hidden");
  }

  function startGps() {
    if (!navigator.geolocation) {
      $("gpsStatus").textContent = "GPS unavailable";
      return;
    }
    if (watchId !== null) return;
    $("gpsStatus").textContent = "Requesting GPS…";
    watchId = navigator.geolocation.watchPosition(
      pos => {
        lastPosition = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
          heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp
        };
        $("gpsStatus").textContent = `GPS ±${Math.round(pos.coords.accuracy)} m`;
        updateNavigation(lastPosition);
      },
      err => $("gpsStatus").textContent = `GPS error: ${err.message}`,
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  }

  function stopGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function toRad(x) { return x * Math.PI / 180; }
  function toDeg(x) { return x * 180 / Math.PI; }
  function normalise360(x) { return (x % 360 + 360) % 360; }

  function distanceBearing(lat1, lon1, lat2, lon2) {
    const R = 6371008.8;
    const p1 = toRad(lat1), p2 = toRad(lat2);
    const dp = toRad(lat2 - lat1), dl = toRad(lon2 - lon1);
    const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    const d = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1)*Math.sin(p2) - Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
    const b = normalise360(toDeg(Math.atan2(y, x)));
    return { metres: d, bearing: b };
  }

  function updateNavigation(pos) {
    const mark = course[currentLeg];
    if (!mark) return;
    const nav = distanceBearing(pos.lat, pos.lon, mark.lat, mark.lon);
    const nm = nav.metres / 1852;
    $("bearing").textContent = `${Math.round(nav.bearing).toString().padStart(3,"0")}°`;
    $("distance").textContent = nm < 1 ? `${Math.round(nav.metres)} m` : `${nm.toFixed(2)} nm`;

    let smgKn = null;
    if (pos.speed !== null && pos.heading !== null) {
      const angle = toRad(normalise360(pos.heading - nav.bearing));
      smgKn = pos.speed * Math.cos(angle) * 1.943844;
      $("smg").textContent = `${smgKn.toFixed(1)} kt`;
    } else {
      $("smg").textContent = "—";
    }

    if (smgKn !== null && smgKn > 0.2) {
      const hours = nm / smgKn;
      const mins = Math.round(hours * 60);
      $("eta").textContent = mins < 60 ? `${mins} min` : `${Math.floor(mins/60)}h ${mins%60}m`;
    } else {
      $("eta").textContent = "—";
    }

    const speedKn = pos.speed !== null ? (pos.speed * 1.943844).toFixed(1) : "—";
    $("gpsDetail").textContent = `SOG ${speedKn} kt · ±${Math.round(pos.accuracy || 0)} m`;

    const radius = Number($("autoRadius").value);
    if (radius > 0) {
      if (nav.metres <= radius && !insideRadius) {
        insideRadius = true;
        navigator.vibrate?.([120,80,120]);
        $("gpsStatus").textContent = `Within ${radius} m — tap Next`;
      } else if (nav.metres > radius * 1.5) {
        insideRadius = false;
      }
    }
  }

  function useDemo() {
    lastPosition = { lat: 50.7662, lon: -1.3005, speed: 3.2, heading: 260, accuracy: 5, timestamp: Date.now() };
    $("gpsStatus").textContent = "Demo position";
    updateNavigation(lastPosition);
  }

  function saveCourse() {
    const name = prompt("Course name", `Course ${new Date().toLocaleDateString()}`);
    if (!name) return;
    const saved = loadSaved();
    saved.unshift({ name, course: course.map(x => ({ code: x.code, rounding: x.rounding })) });
    localStorage.setItem(stateKey, JSON.stringify(saved.slice(0, 30)));
    renderSaved();
  }

  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(stateKey) || "[]"); }
    catch { return []; }
  }

  function renderSaved() {
    const box = $("savedCourses");
    const saved = loadSaved();
    box.innerHTML = saved.length ? "" : "<p class='hint'>No saved courses yet.</p>";
    saved.forEach((s, idx) => {
      const div = document.createElement("div");
      div.className = "savedItem";
      div.innerHTML = `<span><b>${escapeHtml(s.name)}</b><br><small>${s.course.map(x=>x.code).join(" ")}</small></span>
        <span><button data-load="${idx}">Load</button> <button class="secondary" data-del="${idx}">Delete</button></span>`;
      div.querySelector("[data-load]").onclick = () => {
        course = s.course.map(x => ({ ...marksByCode.get(x.code), rounding: x.rounding })).filter(x => x.code);
        $("courseInput").value = s.course.map(x => x.code + (x.rounding ? `(${x.rounding})` : "")).join(" ");
        renderCourse();
      };
      div.querySelector("[data-del]").onclick = () => {
        saved.splice(idx, 1);
        localStorage.setItem(stateKey, JSON.stringify(saved));
        renderSaved();
      };
      box.appendChild(div);
    });
  }

  function renderMarkSearch() {
    const q = $("markSearch").value.trim().toUpperCase();
    const box = $("markResults");
    box.innerHTML = "";
    if (!q) return;
    window.SOLENT_MARKS
      .filter(m => m.code.includes(q) || m.name.toUpperCase().includes(q))
      .slice(0, 30)
      .forEach(m => {
        const div = document.createElement("div");
        div.className = "markItem";
        div.innerHTML = `<span><b>${m.code}</b> ${escapeHtml(m.name)}<br><small>${escapeHtml(m.zoneName)}</small></span><button>Add</button>`;
        div.querySelector("button").onclick = () => {
          const suffix = $("defaultRounding").value ? `(${$("defaultRounding").value})` : "";
          $("courseInput").value = `${$("courseInput").value.trim()} ${m.code}${suffix}`.trim();
          buildCourse();
        };
        box.appendChild(div);
      });
  }

  async function toggleWakeLock() {
    try {
      if (wakeLock) {
        await wakeLock.release();
        wakeLock = null;
        $("wakeBtn").textContent = "Keep awake";
      } else if ("wakeLock" in navigator) {
        wakeLock = await navigator.wakeLock.request("screen");
        $("wakeBtn").textContent = "Awake ✓";
        wakeLock.addEventListener("release", () => {
          wakeLock = null;
          $("wakeBtn").textContent = "Keep awake";
        });
      } else {
        alert("Screen wake lock is not supported by this browser.");
      }
    } catch (e) {
      alert(`Could not keep the screen awake: ${e.message}`);
    }
  }

  $("parseBtn").onclick = buildCourse;
  $("clearBtn").onclick = () => { course=[]; $("courseInput").value=""; renderCourse(); showMessage(""); };
  $("startBtn").onclick = startCourse;
  $("saveBtn").onclick = saveCourse;
  $("nextBtn").onclick = nextLeg;
  $("prevBtn").onclick = previousLeg;
  $("backToSetup").onclick = () => { stopGps(); $("raceView").classList.add("hidden"); $("setupView").classList.remove("hidden"); };
  $("useDemoBtn").onclick = useDemo;
  $("wakeBtn").onclick = toggleWakeLock;
  $("markSearch").addEventListener("input", renderMarkSearch);
  $("courseInput").addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") buildCourse();
  });

  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault(); deferredInstall = e; $("installBtn").classList.remove("hidden");
  });
  $("installBtn").onclick = async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $("installBtn").classList.add("hidden");
  };

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js"));
  }

  renderSaved();
  renderCourse();
})();

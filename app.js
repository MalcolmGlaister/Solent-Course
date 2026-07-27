
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
  let raceMode = "nav";
  const RYS_LINES = {
    "rys-inner": { name: "RYS Inner Line", a: {lat:50.76608, lon:-1.30123}, b:{lat:50.75940, lon:-1.29938}, approximate:true },
    "rys-outer": { name: "RYS Outer Line", a: {lat:50.7866667, lon:-1.3091667}, b:{lat:50.76608, lon:-1.30123}, approximate:true }
  };

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

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function bounds(values, value) {
    if (value <= values[0]) return [0, 0, 0];
    if (value >= values[values.length - 1]) return [values.length - 1, values.length - 1, 0];
    for (let i = 0; i < values.length - 1; i++) {
      if (value >= values[i] && value <= values[i + 1]) {
        return [i, i + 1, (value - values[i]) / (values[i + 1] - values[i])];
      }
    }
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function windInterpolated(values, tws) {
    const [lo, hi, t] = bounds(window.J109_POLAR.windSpeeds, tws);
    return lerp(values[lo], values[hi], t);
  }

  function polarTarget(twa, tws) {
    twa = clamp(Math.abs(Number(twa)), 0, 180);
    tws = clamp(Number(tws), 6, 20);
    const correction = clamp(Number($("polarCorrection").value || 100), 70, 120) / 100;
    const beatAngle = windInterpolated(window.J109_POLAR.beatAngles, tws);
    const beatSpeed = windInterpolated(window.J109_POLAR.beatSpeeds, tws);
    const runAngle = windInterpolated(window.J109_POLAR.runAngles, tws);
    const runSpeed = windInterpolated(window.J109_POLAR.runSpeeds, tws);

    let speed;
    if (twa <= beatAngle) {
      speed = beatSpeed;
    } else if (twa >= runAngle) {
      speed = runSpeed;
    } else {
      const angleRows = [beatAngle, ...window.J109_POLAR.angles.filter(a => a > beatAngle && a < runAngle), runAngle];
      const rowSpeeds = [beatSpeed, ...window.J109_POLAR.angles.filter(a => a > beatAngle && a < runAngle).map(a => windInterpolated(window.J109_POLAR.speeds[String(a)], tws)), runSpeed];
      const [lo, hi, t] = bounds(angleRows, twa);
      speed = lerp(rowSpeeds[lo], rowSpeeds[hi], t);
    }
    const optimumAngle = twa < 90 ? beatAngle : runAngle;
    const optimumSpeed = twa < 90 ? beatSpeed : runSpeed;
    return { speed: speed * correction, optimumAngle, optimumSpeed: optimumSpeed * correction };
  }

  function actualBoatSpeed() {
    if ($("speedSource").value === "manual") return Number($("manualSpeed").value) || null;
    return lastPosition?.speed !== null && lastPosition?.speed !== undefined ? lastPosition.speed * 1.943844 : null;
  }

  function updatePolarDisplays() {
    const tws = Number($("raceTws")?.value || $("twsInput").value);
    const twa = Number($("raceTwa")?.value || $("twaInput").value);
    if (!Number.isFinite(tws) || !Number.isFinite(twa)) return;
    const target = polarTarget(twa, tws);
    const actual = actualBoatSpeed();
    const targetVmg = Math.abs(target.speed * Math.cos(toRad(twa)));
    const actualVmg = actual === null ? null : Math.abs(actual * Math.cos(toRad(twa)));
    const pct = actual === null ? null : actual / target.speed * 100;

    if ($("setupPolarPreview")) {
      $("setupPolarPreview").innerHTML = `<b>Target ${target.speed.toFixed(2)} kt</b> at ${twa.toFixed(0)}° TWA in ${tws.toFixed(1)} kt TWS<br>` +
        `Optimum ${twa < 90 ? "upwind" : "downwind"}: ${target.optimumAngle.toFixed(1)}° at ${target.optimumSpeed.toFixed(2)} kt`;
    }
    if ($("targetSpeed")) {
      $("targetSpeed").textContent = target.speed.toFixed(2);
      $("targetPercent").textContent = pct === null ? "—%" : `${Math.round(pct)}%`;
      $("targetWind").textContent = `${tws.toFixed(1)} kt / ${twa.toFixed(0)}°`;
      $("actualSpeed").textContent = actual === null ? "—" : `${actual.toFixed(2)} kt`;
      $("optimumAngle").textContent = `${target.optimumAngle.toFixed(1)}°`;
      $("optimumSpeed").textContent = `${target.optimumSpeed.toFixed(2)} kt`;
      $("actualWindVmg").textContent = actualVmg === null ? "—" : `${actualVmg.toFixed(2)} kt`;
      $("targetWindVmg").textContent = `${targetVmg.toFixed(2)} kt`;
    }
  }


  function lineFromControls(prefix) {
    const type = $(prefix + "LineType").value;
    if (type === "none") return null;
    if (type === "same") return lineFromControls("start");
    if (RYS_LINES[type]) return { type, ...RYS_LINES[type] };
    const nums = ["ALat","ALon","BLat","BLon"].map(s => Number($(prefix+s).value));
    if (!nums.every(Number.isFinite)) return { type:"committee", name:"Committee boat line", invalid:true };
    return { type:"committee", name:"Committee boat line", a:{lat:nums[0],lon:nums[1]}, b:{lat:nums[2],lon:nums[3]} };
  }

  function updateLineControls(prefix) {
    const type = $(prefix + "LineType").value;
    $(prefix + "LineCoords").classList.toggle("hidden", type !== "committee");
    const line = lineFromControls(prefix);
    const summary = $(prefix + "LineSummary");
    if (type === "same") summary.textContent = "Same as start line";
    else if (!line) summary.textContent = `No ${prefix} line`;
    else if (line.invalid) summary.textContent = "Enter both ends of the committee boat line";
    else summary.textContent = `${line.name}${line.approximate ? " · approximate reference" : ""}`;
    renderCourseMap();
  }

  function lineData() { return { start: lineFromControls("start"), finish: lineFromControls("finish") }; }

  function setRaceMode(mode) {
    raceMode = mode;
    $("navigationPanel").classList.toggle("hidden", mode !== "nav");
    $("targetsPanel").classList.toggle("hidden", mode !== "targets");
    $("mapPanel").classList.toggle("hidden", mode !== "map");
    $("navModeBtn").className = mode === "nav" ? "modeActive" : "secondary";
    $("targetModeBtn").className = mode === "targets" ? "modeActive" : "secondary";
    $("mapModeBtn").className = mode === "map" ? "modeActive" : "secondary";
    if (mode === "targets") updatePolarDisplays();
    if (mode === "map") renderCourseMap();
  }

  function renderCourseMap() {
    const svg = $("courseMap");
    if (!svg) return;
    svg.innerHTML = "";
    $("mapCourseSummary").textContent = course.length ? `START → ${course.map(x => x.code).join(" → ")} → FINISH` : "No course loaded";

    const NS = "http://www.w3.org/2000/svg";
    const add = (tag, attrs = {}, text = "") => {
      const el = document.createElementNS(NS, tag);
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
      if (text) el.textContent = text;
      svg.appendChild(el);
      return el;
    };

    add("rect", { x: 0, y: 0, width: 700, height: 520, class: "mapSea" });
    if (!course.length) {
      add("text", { x: 350, y: 260, class: "mapGridLabel", "text-anchor": "middle" }, "Build a course to display it here");
      return;
    }

    const points = course.map(m => ({ lat: m.lat, lon: m.lon }));
    const lines = lineData();
    [lines.start, lines.finish].forEach(line => { if (line && !line.invalid) points.push(line.a, line.b); });
    if (lastPosition) points.push({ lat: lastPosition.lat, lon: lastPosition.lon });
    let minLat = Math.min(...points.map(p => p.lat));
    let maxLat = Math.max(...points.map(p => p.lat));
    let minLon = Math.min(...points.map(p => p.lon));
    let maxLon = Math.max(...points.map(p => p.lon));
    const latSpan = Math.max(maxLat - minLat, 0.035);
    const lonSpan = Math.max(maxLon - minLon, 0.06);
    minLat -= latSpan * 0.18; maxLat += latSpan * 0.18;
    minLon -= lonSpan * 0.12; maxLon += lonSpan * 0.12;

    const pad = { l: 58, r: 26, t: 30, b: 42 };
    const width = 700 - pad.l - pad.r;
    const height = 520 - pad.t - pad.b;
    const midLat = (minLat + maxLat) / 2;
    const cosLat = Math.cos(toRad(midLat));
    const lonRange = (maxLon - minLon) * cosLat;
    const latRange = maxLat - minLat;
    const scale = Math.min(width / lonRange, height / latRange);
    const usedW = lonRange * scale;
    const usedH = latRange * scale;
    const ox = pad.l + (width - usedW) / 2;
    const oy = pad.t + (height - usedH) / 2;
    const project = (lat, lon) => ({
      x: ox + (lon - minLon) * cosLat * scale,
      y: oy + (maxLat - lat) * scale
    });

    for (let i = 0; i <= 4; i++) {
      const gx = ox + usedW * i / 4;
      const gy = oy + usedH * i / 4;
      add("line", { x1: gx, y1: oy, x2: gx, y2: oy + usedH, class: "mapGrid" });
      add("line", { x1: ox, y1: gy, x2: ox + usedW, y2: gy, class: "mapGrid" });
      const lon = minLon + (maxLon - minLon) * i / 4;
      const lat = maxLat - (maxLat - minLat) * i / 4;
      add("text", { x: gx, y: 505, class: "mapGridLabel", "text-anchor": "middle" }, `${Math.abs(lon).toFixed(2)}°${lon < 0 ? "W" : "E"}`);
      add("text", { x: 8, y: gy + 4, class: "mapGridLabel" }, `${lat.toFixed(2)}°N`);
    }

    add("text", { x: 665, y: 24, class: "mapNorth" }, "N");
    add("path", { d: "M665 30 L657 48 L665 44 L673 48 Z", fill: "#9db1c2" });

    const drawLine = (line, kind, label) => {
      if (!line || line.invalid) return;
      const a = project(line.a.lat, line.a.lon), b = project(line.b.lat, line.b.lon);
      add("line", { x1:a.x, y1:a.y, x2:b.x, y2:b.y, class:`map${kind}Line` });
      add("circle", { cx:a.x, cy:a.y, r:6, class:`mapLineEnd ${kind.toLowerCase()}` });
      add("circle", { cx:b.x, cy:b.y, r:6, class:`mapLineEnd ${kind.toLowerCase()}` });
      add("text", { x:(a.x+b.x)/2, y:(a.y+b.y)/2-10, class:"mapLineLabel", "text-anchor":"middle" }, label);
    };
    drawLine(lines.start, "Start", "START");
    drawLine(lines.finish, "Finish", "FINISH");

    const routePts = course.map(m => project(m.lat, m.lon));
    if (routePts.length > 1) {
      add("polyline", { points: routePts.map(p => `${p.x},${p.y}`).join(" "), class: "mapRoute" });
      const from = currentLeg === 0 && lastPosition ? project(lastPosition.lat, lastPosition.lon) : routePts[Math.max(0, currentLeg - 1)];
      const to = routePts[currentLeg];
      if (from && to) add("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: "mapActiveLeg" });
    }

    course.forEach((mark, i) => {
      const p = routePts[i];
      const cls = i < currentLeg ? "completed" : i === currentLeg ? "active" : "future";
      add("circle", { cx: p.x, cy: p.y, r: i === currentLeg ? 13 : 11, class: `mapMarkCircle ${cls}` });
      add("text", { x: p.x, y: p.y + 0.5, class: "mapOrderLabel" }, String(i + 1));
      const anchor = p.x > 580 ? "end" : "start";
      const dx = anchor === "end" ? -16 : 16;
      add("text", { x: p.x + dx, y: p.y - 13, class: "mapMarkLabel", "text-anchor": anchor }, mark.code);
    });

    if (lastPosition) {
      const b = project(lastPosition.lat, lastPosition.lon);
      const heading = Number.isFinite(lastPosition.heading) ? lastPosition.heading : 0;
      const boat = add("path", { d: "M0 -15 L10 12 L0 7 L-10 12 Z", class: "mapBoat", transform: `translate(${b.x} ${b.y}) rotate(${heading})` });
      boat.setAttribute("aria-label", "Boat position");
    }
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
    renderCourseMap();
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
        applyLineSettings(s.lines);
        renderCourse();
        renderCourseMap();
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
    $("raceTws").value = $("twsInput").value;
    $("raceTwa").value = $("twaInput").value;
    setRaceMode("nav");
    updateRaceDisplay();
    updatePolarDisplays();
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
    updatePolarDisplays();
    renderCourseMap();
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
        if (raceMode === "map") renderCourseMap();
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
    updatePolarDisplays();

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
    renderCourseMap();
  }


  function captureLineSettings() {
    const out = {};
    ["start","finish"].forEach(prefix => {
      out[prefix] = { type: $(prefix+"LineType").value };
      ["ALat","ALon","BLat","BLon"].forEach(s => out[prefix][s] = $(prefix+s).value);
    });
    return out;
  }

  function applyLineSettings(lines) {
    if (!lines) return;
    ["start","finish"].forEach(prefix => {
      const v=lines[prefix]; if(!v) return;
      $(prefix+"LineType").value=v.type;
      ["ALat","ALon","BLat","BLon"].forEach(s => $(prefix+s).value=v[s]||"");
      updateLineControls(prefix);
    });
  }

  function saveCourse() {
    const name = prompt("Course name", `Course ${new Date().toLocaleDateString()}`);
    if (!name) return;
    const saved = loadSaved();
    saved.unshift({ name, course: course.map(x => ({ code: x.code, rounding: x.rounding })), lines: captureLineSettings() });
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
        renderCourseMap();
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


  ["start","finish"].forEach(prefix => {
    $(prefix+"LineType").addEventListener("change", () => updateLineControls(prefix));
    ["ALat","ALon","BLat","BLon"].forEach(s => $(prefix+s).addEventListener("input", () => updateLineControls(prefix)));
  });

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

  $("navModeBtn").onclick = () => setRaceMode("nav");
  $("targetModeBtn").onclick = () => setRaceMode("targets");
  $("mapModeBtn").onclick = () => setRaceMode("map");
  $("fitMapBtn").onclick = renderCourseMap;
  ["twsInput","twaInput","polarCorrection","manualSpeed"].forEach(id => $(id).addEventListener("input", updatePolarDisplays));
  $("speedSource").addEventListener("change", () => {
    $("manualSpeedLabel").classList.toggle("hidden", $("speedSource").value !== "manual");
    updatePolarDisplays();
  });
  $("raceTws").addEventListener("input", () => { $("twsInput").value = $("raceTws").value; updatePolarDisplays(); });
  $("raceTwa").addEventListener("input", () => { $("twaInput").value = $("raceTwa").value; updatePolarDisplays(); });

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

  updateLineControls("start");
  updateLineControls("finish");
  renderSaved();
  renderCourse();
  updatePolarDisplays();
  renderCourseMap();
})();

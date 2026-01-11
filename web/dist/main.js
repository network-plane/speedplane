(() => {
  // web/src/main.ts
  function $(id) {
    const el = document.getElementById(id);
    if (!el) {
      throw new Error(`Missing element #${id}`);
    }
    return el;
  }
  async function fetchJSON(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers || {}
      }
    });
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}`);
    }
    return await res.json();
  }
  function formatNumber(val, digits = 2) {
    if (val == null || Number.isNaN(val)) return "\u2013";
    return val.toFixed(digits);
  }
  function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  function formatTime24h(date) {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  }
  function formatDateTime(date) {
    return `${formatDate(date)} ${formatTime24h(date)}`;
  }
  async function loadSummary() {
    const data = await fetchJSON("/api/summary");
    if (data.latest) {
      $("latest-download-value").textContent = formatNumber(
        data.latest.download_mbps
      );
      $("latest-download-sub").textContent = "Mbps";
      $("latest-upload-value").textContent = formatNumber(
        data.latest.upload_mbps
      );
      $("latest-upload-sub").textContent = "Mbps";
      $("latest-ping-value").textContent = formatNumber(data.latest.ping_ms, 1);
      $("latest-ping-sub").textContent = "ms";
      $("latest-jitter-value").textContent = formatNumber(
        data.latest.jitter_ms ?? 0,
        1
      );
      $("latest-jitter-sub").textContent = "ms";
      $("latest-packetloss-value").textContent = formatNumber(
        data.latest.packet_loss_pct ?? 0,
        2
      );
      $("latest-packetloss-sub").textContent = "%";
    }
  }
  async function loadHistoryTable() {
    const now = /* @__PURE__ */ new Date();
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1e3);
    const url = "/api/history?from=" + encodeURIComponent(from.toISOString()) + "&to=" + encodeURIComponent(now.toISOString());
    const rows = await fetchJSON(url);
    const tbody = $("history-table").querySelector("tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    for (const r of rows) {
      const tr = document.createElement("tr");
      const serverInfo = r.server_name ? `${r.server_name}${r.server_country ? ` (${r.server_country})` : ""}${r.server_id ? ` [${r.server_id}]` : ""}` : r.server_id || "\u2013";
      tr.innerHTML = `
      <td style="font-family: monospace; font-size: 11px;">${r.id.substring(0, 8)}</td>
      <td>${formatDateTime(new Date(r.timestamp))}</td>
      <td>${formatNumber(r.download_mbps)}</td>
      <td>${formatNumber(r.upload_mbps)}</td>
      <td>${formatNumber(r.ping_ms, 1)}</td>
      <td>${formatNumber(r.jitter_ms ?? 0, 1)}</td>
      <td>${formatNumber(r.packet_loss_pct ?? 0, 2)}</td>
      <td style="font-family: monospace; font-size: 12px;">${r.external_ip || "\u2013"}</td>
      <td>${r.isp || "\u2013"}</td>
      <td>${serverInfo}</td>
    `;
      tbody.appendChild(tr);
    }
  }
  function computeRange(range) {
    const to = /* @__PURE__ */ new Date();
    let days = 1;
    if (range === "7d") days = 7;
    if (range === "30d") days = 30;
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1e3);
    return { from, to };
  }
  async function loadHistoryForRange(range) {
    const { from, to } = computeRange(range);
    const url = "/api/history?from=" + encodeURIComponent(from.toISOString()) + "&to=" + encodeURIComponent(to.toISOString());
    const rows = await fetchJSON(url);
    rows.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    return rows;
  }
  function renderLineChart(containerId, rows, key) {
    const container = $(containerId);
    container.innerHTML = "";
    if (!rows.length) {
      container.textContent = "No data for selected range.";
      return;
    }
    const svgNS = "http://www.w3.org/2000/svg";
    const width = 300;
    const height = 50;
    const paddingX = 12;
    const paddingY = 8;
    const paddingBottom = 12;
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const times = rows.map((r) => new Date(r.timestamp).getTime());
    const values = rows.map((r) => {
      const val = r[key];
      if (key === "jitter_ms") {
        return val ?? 0;
      }
      return val;
    });
    const minX = Math.min(...times);
    const maxX = Math.max(...times);
    let minY = Math.min(...values);
    let maxY = Math.max(...values);
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
      container.textContent = "No valid data.";
      return;
    }
    if (minY === maxY) {
      const delta = minY === 0 ? 1 : minY * 0.1;
      minY -= delta;
      maxY += delta;
    }
    const innerW = width - paddingX * 2;
    const innerH = height - paddingY - paddingBottom;
    const gridLines = 3;
    for (let i = 0; i <= gridLines; i++) {
      const yPos = paddingY + innerH / gridLines * i;
      const grid = document.createElementNS(svgNS, "line");
      grid.setAttribute("x1", paddingX.toString());
      grid.setAttribute("x2", (width - paddingX).toString());
      grid.setAttribute("y1", yPos.toString());
      grid.setAttribute("y2", yPos.toString());
      grid.setAttribute("stroke", "rgba(255,255,255,0.08)");
      grid.setAttribute("stroke-width", "0.3");
      svg.appendChild(grid);
      const value = maxY - (maxY - minY) * (i / gridLines);
      const text = document.createElementNS(svgNS, "text");
      text.setAttribute("x", (paddingX - 2).toString());
      text.setAttribute("y", (yPos + 1.5).toString());
      text.setAttribute("text-anchor", "end");
      text.setAttribute("fill", "rgba(255,255,255,0.4)");
      text.setAttribute("font-size", "2.5");
      text.textContent = formatNumber(value, 1);
      svg.appendChild(text);
    }
    const coords = rows.map((r) => {
      const t = new Date(r.timestamp).getTime();
      const xNorm = maxX === minX ? 0 : (t - minX) / (maxX - minX);
      const v = r[key];
      const yNorm = maxY === minY ? 0.5 : (v - minY) / (maxY - minY);
      const x = paddingX + xNorm * innerW;
      const y = paddingY + innerH - yNorm * innerH;
      return { x, y, time: t };
    });
    coords.forEach((coord) => {
      const vLine = document.createElementNS(svgNS, "line");
      vLine.setAttribute("x1", coord.x.toString());
      vLine.setAttribute("x2", coord.x.toString());
      vLine.setAttribute("y1", paddingY.toString());
      vLine.setAttribute("y2", (paddingY + innerH).toString());
      vLine.setAttribute("stroke", "rgba(255,255,255,0.06)");
      vLine.setAttribute("stroke-width", "0.2");
      svg.appendChild(vLine);
    });
    const path = document.createElementNS(svgNS, "path");
    const d = coords.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "rgba(255,179,65,0.9)");
    path.setAttribute("stroke-width", "0.8");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    svg.appendChild(path);
    coords.forEach((coord) => {
      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("cx", coord.x.toString());
      circle.setAttribute("cy", coord.y.toString());
      circle.setAttribute("r", "1.2");
      circle.setAttribute("fill", "#ffb341");
      svg.appendChild(circle);
    });
    const labelCount = Math.min(rows.length, 6);
    const labelStep = Math.max(1, Math.floor(rows.length / labelCount));
    for (let i = 0; i < rows.length; i += labelStep) {
      if (i >= coords.length) break;
      const coord = coords[i];
      const date = new Date(rows[i].timestamp);
      const timeStr = `${formatTime24h(date)}`;
      const text = document.createElementNS(svgNS, "text");
      text.setAttribute("x", coord.x.toString());
      text.setAttribute("y", (height - paddingBottom + 8).toString());
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("fill", "rgba(255,255,255,0.4)");
      text.setAttribute("font-size", "2.5");
      text.textContent = timeStr;
      svg.appendChild(text);
    }
    container.appendChild(svg);
  }
  async function updateDownloadChart() {
    const select = $("range-download");
    const value = select.value || "24h";
    const rows = await loadHistoryForRange(value);
    renderLineChart("download-chart", rows, "download_mbps");
  }
  async function updateUploadChart() {
    const select = $("range-upload");
    const value = select.value || "24h";
    const rows = await loadHistoryForRange(value);
    renderLineChart("upload-chart", rows, "upload_mbps");
  }
  async function updateLatencyChart() {
    const select = $("range-latency");
    const value = select.value || "24h";
    const rows = await loadHistoryForRange(value);
    renderLineChart("latency-chart", rows, "ping_ms");
  }
  async function updateJitterChart() {
    const select = $("range-jitter");
    const value = select.value || "24h";
    const rows = await loadHistoryForRange(value);
    renderLineChart("jitter-chart", rows, "jitter_ms");
  }
  var editingScheduleId = null;
  async function loadSchedules() {
    const scheds = await fetchJSON("/api/schedules");
    const list = $("schedules-list");
    list.innerHTML = "";
    if (!scheds.length) {
      list.textContent = "No schedules configured yet.";
      return;
    }
    for (const s of scheds) {
      const card = document.createElement("div");
      card.className = "schedule-card";
      card.dataset.scheduleId = s.id;
      const scheduleInfo = document.createElement("div");
      scheduleInfo.className = "schedule-info";
      const nameEl = document.createElement("div");
      nameEl.className = "schedule-name";
      nameEl.textContent = s.name || s.id;
      const detailsEl = document.createElement("div");
      detailsEl.className = "schedule-details";
      const typeText = s.type === "interval" ? `Every ${s.every}` : `Daily at ${s.time_of_day}`;
      const statusText = s.enabled ? "Enabled" : "Disabled";
      detailsEl.textContent = `${typeText} \u2022 ${statusText}`;
      scheduleInfo.appendChild(nameEl);
      scheduleInfo.appendChild(detailsEl);
      const actions = document.createElement("div");
      actions.className = "schedule-actions";
      const toggleBtn = document.createElement("button");
      toggleBtn.className = "schedule-btn schedule-btn-toggle";
      toggleBtn.innerHTML = s.enabled ? "\u2713" : "\u25CB";
      toggleBtn.title = s.enabled ? "Disable" : "Enable";
      toggleBtn.addEventListener("click", async () => {
        const updated = { ...s, enabled: !s.enabled };
        try {
          await fetchJSON(`/api/schedules/${s.id}`, {
            method: "PUT",
            body: JSON.stringify(updated)
          });
          await loadSchedules();
        } catch (err) {
          console.error("toggle schedule failed", err);
        }
      });
      const editBtn = document.createElement("button");
      editBtn.className = "schedule-btn schedule-btn-edit";
      editBtn.innerHTML = "\u270E";
      editBtn.title = "Edit";
      editBtn.addEventListener("click", () => {
        editingScheduleId = s.id;
        $("schedule-form-id").value = s.id;
        $("schedule-form-name").value = s.name || "";
        $("schedule-form-type").value = s.type;
        $("schedule-form-every").value = s.every || "";
        $("schedule-form-timeOfDay").value = s.time_of_day || "";
        $("schedule-form-enabled").checked = s.enabled;
        $("schedule-form-submit").textContent = "Update schedule";
        $("schedule-form-cancel").style.display = "inline-block";
        document.getElementById("schedule-form")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "schedule-btn schedule-btn-delete";
      deleteBtn.innerHTML = "\u{1F5D1}";
      deleteBtn.title = "Delete";
      deleteBtn.addEventListener("click", async () => {
        if (!confirm(`Delete schedule "${s.name || s.id}"?`)) return;
        try {
          await fetchJSON(`/api/schedules/${s.id}`, {
            method: "DELETE"
          });
          await loadSchedules();
        } catch (err) {
          console.error("delete schedule failed", err);
        }
      });
      actions.appendChild(toggleBtn);
      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);
      card.appendChild(scheduleInfo);
      card.appendChild(actions);
      list.appendChild(card);
    }
  }
  function setupNav() {
    const buttons = document.querySelectorAll(".nav-item");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view;
        if (!view) return;
        buttons.forEach((b) => b.classList.remove("nav-item-active"));
        btn.classList.add("nav-item-active");
        document.querySelectorAll(".view").forEach((v) => v.classList.remove("view-active"));
        const el = document.getElementById(`view-${view}`);
        if (el) el.classList.add("view-active");
      });
    });
  }
  function setupRunNow() {
    const btn = document.getElementById("run-now-btn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Running...";
      try {
        await fetchJSON("/api/run", { method: "POST" });
        await Promise.all([
          loadSummary(),
          loadHistoryTable(),
          updateDownloadChart(),
          updateUploadChart()
        ]);
      } catch (err) {
        console.error("run-now failed", err);
      } finally {
        btn.disabled = false;
        btn.textContent = "Run speedtest now";
      }
    });
  }
  function setupScheduleForm() {
    const form = document.getElementById("schedule-form");
    if (!form) return;
    const cancelBtn = $("schedule-form-cancel");
    cancelBtn.addEventListener("click", () => {
      editingScheduleId = null;
      form.reset();
      $("schedule-form-id").value = "";
      $("schedule-form-enabled").checked = true;
      $("schedule-form-submit").textContent = "Add schedule";
      cancelBtn.style.display = "none";
    });
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const data = new FormData(form);
      const id = data.get("id") || "";
      const payload = {
        name: data.get("name") || "",
        type: data.get("type") || "interval",
        enabled: data.get("enabled") === "on",
        every: data.get("every") || "",
        time_of_day: data.get("timeOfDay") || ""
      };
      try {
        if (editingScheduleId) {
          await fetchJSON(`/api/schedules/${editingScheduleId}`, {
            method: "PUT",
            body: JSON.stringify(payload)
          });
        } else {
          await fetchJSON("/api/schedules", {
            method: "POST",
            body: JSON.stringify(payload)
          });
        }
        form.reset();
        $("schedule-form-id").value = "";
        $("schedule-form-enabled").checked = true;
        $("schedule-form-submit").textContent = "Add schedule";
        cancelBtn.style.display = "none";
        editingScheduleId = null;
        await loadSchedules();
      } catch (err) {
        console.error("save schedule failed", err);
      }
    });
  }
  function setupRangeSelectors() {
    const d = $("range-download");
    const u = $("range-upload");
    const l = $("range-latency");
    const j = $("range-jitter");
    d.addEventListener("change", () => {
      updateDownloadChart().catch(
        (err) => console.error("updateDownloadChart", err)
      );
    });
    u.addEventListener("change", () => {
      updateUploadChart().catch(
        (err) => console.error("updateUploadChart", err)
      );
    });
    l.addEventListener("change", () => {
      updateLatencyChart().catch(
        (err) => console.error("updateLatencyChart", err)
      );
    });
    j.addEventListener("change", () => {
      updateJitterChart().catch(
        (err) => console.error("updateJitterChart", err)
      );
    });
  }
  async function init() {
    setupNav();
    setupRunNow();
    setupScheduleForm();
    setupRangeSelectors();
    await Promise.all([
      loadSummary(),
      loadHistoryTable(),
      loadSchedules(),
      updateDownloadChart(),
      updateUploadChart(),
      updateLatencyChart(),
      updateJitterChart()
    ]);
  }
  document.addEventListener("DOMContentLoaded", () => {
    init().catch((err) => console.error(err));
  });
})();
//# sourceMappingURL=main.js.map

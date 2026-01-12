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
  function updateComparison(compareEl, latest, average, isLowerBetter) {
    if (!average || average === 0 || !latest || latest < 0) {
      compareEl.textContent = "";
      compareEl.className = "card-compare";
      return;
    }
    const percentDiff = (latest - average) / average * 100;
    const absPercent = Math.abs(percentDiff);
    if (absPercent < 0.1) {
      compareEl.textContent = "";
      compareEl.className = "card-compare";
      return;
    }
    let isSlower;
    if (isLowerBetter) {
      isSlower = percentDiff > 0;
    } else {
      isSlower = percentDiff < 0;
    }
    const arrow = isSlower ? isLowerBetter ? "\u2191" : "\u2193" : isLowerBetter ? "\u2193" : "\u2191";
    const text = isSlower ? "slower" : "faster";
    const className = isSlower ? "card-compare slower" : "card-compare faster";
    compareEl.className = className;
    compareEl.innerHTML = `<span class="arrow">${arrow}</span> ${formatNumber(absPercent, 2)}% ${text}`;
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
      const packetLoss = data.latest.packet_loss_pct ?? -1;
      if (packetLoss < 0) {
        $("latest-packetloss-value").textContent = "\u2014";
        $("latest-packetloss-sub").textContent = "";
      } else {
        $("latest-packetloss-value").textContent = formatNumber(packetLoss, 2);
        $("latest-packetloss-sub").textContent = "%";
      }
      const avg30 = data.averages["last30days"];
      if (avg30) {
        updateComparison(
          $("latest-download-compare"),
          data.latest.download_mbps,
          avg30.avg_download_mbps,
          false
          // Higher is better
        );
        updateComparison(
          $("latest-upload-compare"),
          data.latest.upload_mbps,
          avg30.avg_upload_mbps,
          false
          // Higher is better
        );
        updateComparison(
          $("latest-ping-compare"),
          data.latest.ping_ms,
          avg30.avg_ping_ms,
          true
          // Lower is better
        );
        if (data.latest.jitter_ms !== void 0 && data.latest.jitter_ms >= 0) {
          updateComparison(
            $("latest-jitter-compare"),
            data.latest.jitter_ms,
            avg30.avg_jitter_ms,
            true
            // Lower is better
          );
        } else {
          $("latest-jitter-compare").textContent = "";
          $("latest-jitter-compare").className = "card-compare";
        }
        if (packetLoss >= 0) {
          updateComparison(
            $("latest-packetloss-compare"),
            packetLoss,
            avg30.avg_packet_loss_pct,
            true
            // Lower is better
          );
        } else {
          $("latest-packetloss-compare").textContent = "";
          $("latest-packetloss-compare").className = "card-compare";
        }
      }
    }
  }
  async function loadHistoryTable() {
    const url = "/api/history?range=24h";
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
      <td>${(r.packet_loss_pct ?? -1) < 0 ? "\u2014" : formatNumber(r.packet_loss_pct ?? 0, 2)}</td>
      <td style="font-family: monospace; font-size: 12px;">${r.external_ip || "\u2013"}</td>
      <td>${r.isp || "\u2013"}</td>
      <td>${serverInfo}</td>
    `;
      tbody.appendChild(tr);
    }
  }
  async function loadHistoryForRange(range) {
    const url = "/api/history?range=" + encodeURIComponent(range);
    return await fetchJSON(url);
  }
  async function loadChartData(range, metric) {
    const url = "/api/chart-data?range=" + encodeURIComponent(range) + "&metric=" + encodeURIComponent(metric);
    return await fetchJSON(url);
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
    svg.style.width = "100%";
    svg.style.height = "100%";
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
    const tooltip = document.createElement("div");
    tooltip.style.cssText = `
    position: fixed;
    background: rgba(26, 26, 26, 0.95);
    border: 1px solid var(--border, rgba(255,140,0,.25));
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 11px;
    color: var(--txt, #E8E8E8);
    pointer-events: none;
    z-index: 10000;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    display: none;
    white-space: nowrap;
  `;
    document.body.appendChild(tooltip);
    const getMetricInfo = (k) => {
      switch (k) {
        case "download_mbps":
          return { name: "Download", unit: "Mbps" };
        case "upload_mbps":
          return { name: "Upload", unit: "Mbps" };
        case "ping_ms":
          return { name: "Ping", unit: "ms" };
        case "jitter_ms":
          return { name: "Jitter", unit: "ms" };
        default:
          return { name: "Value", unit: "" };
      }
    };
    const metricInfo = getMetricInfo(key);
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
    const avgValue = values.reduce((sum, val) => sum + val, 0) / values.length;
    if (Number.isFinite(avgValue) && avgValue >= minY && avgValue <= maxY) {
      const avgYNorm = (avgValue - minY) / (maxY - minY);
      const avgY = paddingY + innerH - avgYNorm * innerH;
      const avgLine = document.createElementNS(svgNS, "line");
      avgLine.setAttribute("x1", paddingX.toString());
      avgLine.setAttribute("x2", (width - paddingX).toString());
      avgLine.setAttribute("y1", avgY.toString());
      avgLine.setAttribute("y2", avgY.toString());
      avgLine.setAttribute("stroke", "#ff4757");
      avgLine.setAttribute("stroke-width", "0.6");
      avgLine.setAttribute("stroke-dasharray", "2,2");
      avgLine.setAttribute("opacity", "0.8");
      avgLine.style.cursor = "pointer";
      avgLine.addEventListener("mouseenter", (e) => {
        const svgRect = svg.getBoundingClientRect();
        const scaleY = svgRect.height / height;
        const mouseX = e.clientX;
        const y = svgRect.top + avgY * scaleY;
        tooltip.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 2px;">Average ${metricInfo.name}</div>
        <div>${formatNumber(avgValue, 2)} ${metricInfo.unit}</div>
        <div style="color: var(--muted, #B0B0B0); font-size: 10px; margin-top: 2px;">Based on ${rows.length} measurement${rows.length !== 1 ? "s" : ""}</div>
      `;
        tooltip.style.display = "block";
        const tooltipRect = tooltip.getBoundingClientRect();
        tooltip.style.left = `${mouseX - tooltipRect.width / 2}px`;
        tooltip.style.top = `${y - tooltipRect.height - 8}px`;
      });
      avgLine.addEventListener("mouseleave", () => {
        tooltip.style.display = "none";
      });
      svg.appendChild(avgLine);
    }
    const path = document.createElementNS(svgNS, "path");
    const d = coords.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "rgba(255,179,65,0.9)");
    path.setAttribute("stroke-width", "0.8");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    svg.appendChild(path);
    coords.forEach((coord, index) => {
      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("cx", coord.x.toString());
      circle.setAttribute("cy", coord.y.toString());
      circle.setAttribute("r", "1.2");
      circle.setAttribute("fill", "#ffb341");
      circle.style.cursor = "pointer";
      const row = rows[index];
      const value = values[index];
      const date = new Date(row.timestamp);
      circle.addEventListener("mouseenter", (e) => {
        const svgRect = svg.getBoundingClientRect();
        const scaleX = svgRect.width / width;
        const scaleY = svgRect.height / height;
        circle.setAttribute("r", "1.4");
        circle.setAttribute("fill", "#ffb341");
        circle.setAttribute("stroke", "#ffd700");
        circle.setAttribute("stroke-width", "0.5");
        tooltip.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 2px;">${metricInfo.name}</div>
        <div>${formatNumber(value, 2)} ${metricInfo.unit}</div>
        <div style="color: var(--muted, #B0B0B0); font-size: 10px; margin-top: 2px;">${formatDateTime(date)}</div>
      `;
        tooltip.style.display = "block";
        const x = svgRect.left + coord.x * scaleX;
        const y = svgRect.top + coord.y * scaleY;
        const tooltipRect = tooltip.getBoundingClientRect();
        tooltip.style.left = `${x - tooltipRect.width / 2}px`;
        tooltip.style.top = `${y - tooltipRect.height - 8}px`;
      });
      circle.addEventListener("mouseleave", () => {
        circle.setAttribute("r", "1.2");
        circle.setAttribute("fill", "#ffb341");
        circle.removeAttribute("stroke");
        circle.removeAttribute("stroke-width");
        tooltip.style.display = "none";
      });
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
  async function renderPercentileChart(containerId, range, metric) {
    const container = $(containerId);
    container.innerHTML = "";
    const chartData = await loadChartData(range, metric);
    const rows = chartData.data;
    if (!rows.length || !chartData.stats) {
      container.textContent = "No data for selected range.";
      return;
    }
    const stats = chartData.stats;
    const svgNS = "http://www.w3.org/2000/svg";
    const width = 300;
    const height = 50;
    const paddingX = 12;
    const paddingY = 8;
    const paddingBottom = 12;
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.width = "100%";
    svg.style.height = "100%";
    let minY = Math.min(stats.min, stats.p10);
    let maxY = Math.max(stats.max, stats.p90);
    if (minY === maxY) {
      const delta = minY === 0 ? 1 : minY * 0.1;
      minY -= delta;
      maxY += delta;
    }
    const innerW = width - paddingX * 2;
    const innerH = height - paddingY - paddingBottom;
    const yPos = (val) => {
      const yNorm = maxY === minY ? 0.5 : (val - minY) / (maxY - minY);
      return paddingY + innerH - yNorm * innerH;
    };
    const gridLines = 3;
    for (let i = 0; i <= gridLines; i++) {
      const yPos2 = paddingY + innerH / gridLines * i;
      const grid = document.createElementNS(svgNS, "line");
      grid.setAttribute("x1", paddingX.toString());
      grid.setAttribute("x2", (width - paddingX).toString());
      grid.setAttribute("y1", yPos2.toString());
      grid.setAttribute("y2", yPos2.toString());
      grid.setAttribute("stroke", "rgba(255,255,255,0.08)");
      grid.setAttribute("stroke-width", "0.3");
      svg.appendChild(grid);
      const value = maxY - (maxY - minY) * (i / gridLines);
      const text = document.createElementNS(svgNS, "text");
      text.setAttribute("x", (paddingX - 2).toString());
      text.setAttribute("y", (yPos2 + 1.5).toString());
      text.setAttribute("text-anchor", "end");
      text.setAttribute("fill", "rgba(255,255,255,0.4)");
      text.setAttribute("font-size", "2.5");
      text.textContent = formatNumber(value, 1);
      svg.appendChild(text);
    }
    const centerX = width / 2;
    const boxWidth = innerW * 0.4;
    const whisker = (y1, y2, x) => {
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", x.toString());
      line.setAttribute("x2", x.toString());
      line.setAttribute("y1", y1.toString());
      line.setAttribute("y2", y2.toString());
      line.setAttribute("stroke", "rgba(255,255,255,0.5)");
      line.setAttribute("stroke-width", "0.4");
      svg.appendChild(line);
    };
    whisker(yPos(stats.min), yPos(stats.p10), centerX);
    whisker(yPos(stats.p90), yPos(stats.max), centerX);
    const boxY1 = yPos(stats.q3);
    const boxY2 = yPos(stats.q1);
    const box = document.createElementNS(svgNS, "rect");
    box.setAttribute("x", (centerX - boxWidth / 2).toString());
    box.setAttribute("y", boxY1.toString());
    box.setAttribute("width", boxWidth.toString());
    box.setAttribute("height", (boxY2 - boxY1).toString());
    box.setAttribute("fill", "rgba(255,179,65,0.2)");
    box.setAttribute("stroke", "rgba(255,179,65,0.6)");
    box.setAttribute("stroke-width", "0.5");
    svg.appendChild(box);
    const medianY = yPos(stats.median);
    const medianLine = document.createElementNS(svgNS, "line");
    medianLine.setAttribute("x1", (centerX - boxWidth / 2).toString());
    medianLine.setAttribute("x2", (centerX + boxWidth / 2).toString());
    medianLine.setAttribute("y1", medianY.toString());
    medianLine.setAttribute("y2", medianY.toString());
    medianLine.setAttribute("stroke", "#ffb341");
    medianLine.setAttribute("stroke-width", "1");
    svg.appendChild(medianLine);
    const markers = [
      { val: stats.min, label: "Min", color: "rgba(255,255,255,0.6)" },
      { val: stats.p10, label: "P10", color: "rgba(255,255,255,0.5)" },
      { val: stats.q1, label: "Q1", color: "rgba(255,179,65,0.7)" },
      { val: stats.median, label: "Med", color: "#ffb341" },
      { val: stats.q3, label: "Q3", color: "rgba(255,179,65,0.7)" },
      { val: stats.p90, label: "P90", color: "rgba(255,255,255,0.5)" },
      { val: stats.max, label: "Max", color: "rgba(255,255,255,0.6)" }
    ];
    markers.forEach((m) => {
      const y = yPos(m.val);
      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("cx", centerX.toString());
      circle.setAttribute("cy", y.toString());
      circle.setAttribute("r", "1");
      circle.setAttribute("fill", m.color);
      svg.appendChild(circle);
    });
    const statsText = document.createElementNS(svgNS, "text");
    statsText.setAttribute("x", centerX.toString());
    statsText.setAttribute("y", (height - paddingBottom + 6).toString());
    statsText.setAttribute("text-anchor", "middle");
    statsText.setAttribute("fill", "rgba(255,255,255,0.5)");
    statsText.setAttribute("font-size", "2.2");
    statsText.textContent = `Med: ${formatNumber(stats.median, 1)} | Q1: ${formatNumber(stats.q1, 1)} | Q3: ${formatNumber(stats.q3, 1)}`;
    svg.appendChild(statsText);
    container.appendChild(svg);
  }
  async function updateDownloadChart() {
    const select = $("range-download");
    const toggle = $("chart-type-download");
    const value = select.value || "24h";
    if (toggle?.classList.contains("active")) {
      await renderPercentileChart("download-chart", value, "download");
    } else {
      const rows = await loadHistoryForRange(value);
      renderLineChart("download-chart", rows, "download_mbps");
    }
  }
  async function updateUploadChart() {
    const select = $("range-upload");
    const toggle = $("chart-type-upload");
    const value = select.value || "24h";
    if (toggle?.classList.contains("active")) {
      await renderPercentileChart("upload-chart", value, "upload");
    } else {
      const rows = await loadHistoryForRange(value);
      renderLineChart("upload-chart", rows, "upload_mbps");
    }
  }
  async function updateLatencyChart() {
    const select = $("range-latency");
    const toggle = $("chart-type-latency");
    const value = select.value || "24h";
    if (toggle?.classList.contains("active")) {
      await renderPercentileChart("latency-chart", value, "ping");
    } else {
      const rows = await loadHistoryForRange(value);
      renderLineChart("latency-chart", rows, "ping_ms");
    }
  }
  async function updateJitterChart() {
    const select = $("range-jitter");
    const toggle = $("chart-type-jitter");
    const value = select.value || "24h";
    if (toggle?.classList.contains("active")) {
      await renderPercentileChart("jitter-chart", value, "jitter");
    } else {
      const rows = await loadHistoryForRange(value);
      renderLineChart("jitter-chart", rows, "jitter_ms");
    }
  }
  var editingScheduleId = null;
  async function loadSchedules() {
    const scheds = await fetchJSON("/api/schedules");
    const list = $("schedules-list");
    list.innerHTML = "";
    updateScheduleTimer();
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
        $("schedule-form-submit").textContent = "Update";
        toggleScheduleFields(s.type);
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
          card.remove();
          await loadSchedules();
        } catch (err) {
          console.error("delete schedule failed", err);
          alert("Failed to delete schedule. Please refresh the page.");
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
    const sidebar = document.getElementById("sidebar");
    const sidebarToggle = document.getElementById("sidebar-toggle");
    const isExpanded = localStorage.getItem("sidebar-expanded") === "true";
    if (sidebar) {
      if (isExpanded) {
        sidebar.classList.remove("collapsed");
      } else {
        sidebar.classList.add("collapsed");
      }
      if (sidebarToggle) {
        sidebarToggle.addEventListener("click", () => {
          sidebar.classList.toggle("collapsed");
          const expanded = !sidebar.classList.contains("collapsed");
          localStorage.setItem("sidebar-expanded", String(expanded));
        });
      }
    }
    const buttons = document.querySelectorAll(".nav-item");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (sidebar && sidebar.classList.contains("collapsed")) {
          sidebar.classList.remove("collapsed");
          localStorage.setItem("sidebar-expanded", "true");
        }
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
      btn.textContent = "Starting...";
      const modal = showProgressModal();
      const statusEl = modal.querySelector(".progress-status");
      const messageEl = modal.querySelector(".progress-message");
      try {
        const result = await runSpeedtestWithProgress((stage, message) => {
          if (statusEl) statusEl.textContent = stage;
          if (messageEl) messageEl.textContent = message;
          btn.textContent = message;
        });
        closeProgressModal(modal);
        await Promise.all([
          loadSummary(),
          loadHistoryTable(),
          updateDownloadChart(),
          updateUploadChart(),
          updateLatencyChart(),
          updateJitterChart()
        ]);
      } catch (err) {
        console.error("run-now failed", err);
        closeProgressModal(modal);
        alert("Speedtest failed: " + (err instanceof Error ? err.message : String(err)));
      } finally {
        btn.disabled = false;
        btn.textContent = "Run speedtest now";
      }
    });
  }
  function showProgressModal() {
    const modal = document.createElement("div");
    modal.className = "progress-modal-overlay";
    modal.innerHTML = `
    <div class="progress-modal">
      <div class="progress-header">
        <h3>Running Speedtest</h3>
      </div>
      <div class="progress-content">
        <div class="progress-spinner"></div>
        <div class="progress-status"></div>
        <div class="progress-message"></div>
      </div>
    </div>
  `;
    document.body.appendChild(modal);
    return modal;
  }
  function closeProgressModal(modal) {
    if (modal && modal.parentNode) {
      modal.parentNode.removeChild(modal);
    }
  }
  async function runSpeedtestWithProgress(onProgress) {
    return new Promise((resolve, reject) => {
      fetch("/api/run/stream", { method: "POST" }).then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        if (!response.body) {
          throw new Error("Response body is null");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        function processChunk() {
          return reader.read().then(({ done, value }) => {
            if (done) {
              if (buffer.trim()) {
                const lines2 = buffer.split("\n");
                for (const line of lines2) {
                  if (line.startsWith("data: ")) {
                    try {
                      const data = JSON.parse(line.slice(6));
                      if (data.type === "completed") {
                        resolve(data.result);
                        return;
                      } else if (data.type === "error") {
                        reject(new Error(data.message || "Speedtest failed"));
                        return;
                      }
                    } catch (e) {
                      console.error("Failed to parse SSE data:", e);
                    }
                  }
                }
              }
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.type === "progress") {
                    onProgress(data.stage || "", data.message || "");
                  } else if (data.type === "completed") {
                    reader.cancel();
                    resolve(data.result);
                    return;
                  } else if (data.type === "error") {
                    reader.cancel();
                    reject(new Error(data.message || "Speedtest failed"));
                    return;
                  } else if (data.type === "started") {
                  }
                } catch (e) {
                  console.error("Failed to parse SSE data:", e, line);
                }
              }
            }
            return processChunk();
          });
        }
        return processChunk();
      }).catch(reject);
    });
  }
  function toggleScheduleFields(type) {
    const everyField = document.getElementById("schedule-form-every-field");
    const timeOfDayField = document.getElementById("schedule-form-timeOfDay-field");
    if (type === "interval") {
      if (everyField) everyField.style.display = "";
      if (timeOfDayField) timeOfDayField.style.display = "none";
    } else if (type === "daily") {
      if (everyField) everyField.style.display = "none";
      if (timeOfDayField) timeOfDayField.style.display = "";
    }
  }
  function setupScheduleForm() {
    const form = document.getElementById("schedule-form");
    if (!form) return;
    const typeSelect = $("schedule-form-type");
    typeSelect.addEventListener("change", () => {
      toggleScheduleFields(typeSelect.value);
    });
    toggleScheduleFields(typeSelect.value);
    const cancelBtn = $("schedule-form-cancel");
    cancelBtn.addEventListener("click", () => {
      editingScheduleId = null;
      form.reset();
      $("schedule-form-id").value = "";
      $("schedule-form-enabled").checked = true;
      $("schedule-form-submit").textContent = "Add";
      cancelBtn.style.display = "none";
      toggleScheduleFields(typeSelect.value);
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
        $("schedule-form-submit").textContent = "Add";
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
    const dt = $("chart-type-download");
    const ut = $("chart-type-upload");
    const lt = $("chart-type-latency");
    const jt = $("chart-type-jitter");
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
    dt?.addEventListener("click", () => {
      dt.classList.toggle("active");
      updateDownloadChart().catch(
        (err) => console.error("updateDownloadChart", err)
      );
    });
    ut?.addEventListener("click", () => {
      ut.classList.toggle("active");
      updateUploadChart().catch(
        (err) => console.error("updateUploadChart", err)
      );
    });
    lt?.addEventListener("click", () => {
      lt.classList.toggle("active");
      updateLatencyChart().catch(
        (err) => console.error("updateLatencyChart", err)
      );
    });
    jt?.addEventListener("click", () => {
      jt.classList.toggle("active");
      updateJitterChart().catch(
        (err) => console.error("updateJitterChart", err)
      );
    });
  }
  async function loadSchemesForTemplate(templateName) {
    const schemeSelect = $("pref-scheme");
    const currentScheme = localStorage.getItem("scheme") || "default";
    try {
      const schemes = await fetchJSON(`/api/schemes?template=${encodeURIComponent(templateName)}`);
      schemeSelect.innerHTML = "";
      schemes.forEach((scheme) => {
        const option = document.createElement("option");
        option.value = scheme.name;
        option.textContent = scheme.display || scheme.name;
        if (scheme.name === currentScheme) {
          option.selected = true;
        }
        schemeSelect.appendChild(option);
      });
      if (schemeSelect.options.length === 0) {
        const option = document.createElement("option");
        option.value = "default";
        option.textContent = "Default";
        option.selected = true;
        schemeSelect.appendChild(option);
      }
    } catch (err) {
      console.error("Failed to load schemes:", err);
    }
  }
  async function applyTheme(templateName, schemeName) {
    try {
      const response = await fetch(
        `/api/theme?template=${encodeURIComponent(templateName)}&scheme=${encodeURIComponent(schemeName)}`
      );
      if (!response.ok) {
        throw new Error(`Failed to load theme: ${response.status}`);
      }
      const css = await response.text();
      const styleEl = document.getElementById("theme-css");
      if (styleEl) {
        styleEl.textContent = css;
      }
      document.documentElement.setAttribute("data-template", templateName);
      document.documentElement.setAttribute("data-scheme", schemeName);
      localStorage.setItem("template", templateName);
      localStorage.setItem("scheme", schemeName);
    } catch (err) {
      console.error("Failed to apply theme:", err);
    }
  }
  function setupThemeSelection() {
    const templateSelect = $("pref-template");
    const schemeSelect = $("pref-scheme");
    const savedTemplate = localStorage.getItem("template");
    const savedScheme = localStorage.getItem("scheme");
    const htmlTemplate = document.documentElement.getAttribute("data-template");
    const htmlScheme = document.documentElement.getAttribute("data-scheme");
    const currentTemplate = savedTemplate || htmlTemplate || "speedplane";
    const currentScheme = savedScheme || htmlScheme || "default";
    if (Array.from(templateSelect.options).some((opt) => opt.value === currentTemplate)) {
      templateSelect.value = currentTemplate;
    }
    loadSchemesForTemplate(currentTemplate).catch(
      (err) => console.error("loadSchemesForTemplate", err)
    );
    templateSelect.addEventListener("change", async () => {
      const newTemplate = templateSelect.value;
      localStorage.setItem("template", newTemplate);
      localStorage.setItem("scheme", "default");
      await loadSchemesForTemplate(newTemplate);
      schemeSelect.value = "default";
      await applyTheme(newTemplate, "default");
    });
    schemeSelect.addEventListener("change", async () => {
      const newScheme = schemeSelect.value;
      const template = templateSelect.value;
      await applyTheme(template, newScheme);
    });
  }
  var scheduleTimerInterval = null;
  var nextRunTime = null;
  var intervalDuration = null;
  var intervalStartTime = null;
  var ws = null;
  async function updateScheduleTimer() {
    try {
      const data = await fetchJSON("/api/next-run");
      const timerEl = document.getElementById("schedule-timer");
      if (!timerEl) return;
      if (!data.next_run) {
        timerEl.style.display = "none";
        if (scheduleTimerInterval) {
          clearInterval(scheduleTimerInterval);
          scheduleTimerInterval = null;
        }
        nextRunTime = null;
        intervalDuration = null;
        intervalStartTime = null;
        return;
      }
      timerEl.style.display = "block";
      const nextRun = new Date(data.next_run).getTime();
      nextRunTime = nextRun;
      intervalDuration = (data.interval_duration || 0) * 1e3;
      intervalStartTime = nextRun - intervalDuration;
      updateTimerDisplay();
    } catch (err) {
      console.error("Failed to fetch next run time:", err);
    }
  }
  function updateTimerDisplay() {
    const timerEl = document.getElementById("schedule-timer");
    if (!timerEl || !nextRunTime || !intervalDuration || !intervalStartTime) return;
    const now = Date.now();
    const remaining = Math.max(0, nextRunTime - now);
    const elapsed = now - intervalStartTime;
    const percent = Math.min(100, Math.max(0, elapsed / intervalDuration * 100));
    const totalSeconds = Math.ceil(remaining / 1e3);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor(totalSeconds % 86400 / 3600);
    const minutes = Math.floor(totalSeconds % 3600 / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    const timeStr = parts.join(" ");
    if (remaining > 0) {
      timerEl.title = `Next speedtest in ${timeStr}`;
      timerEl.classList.remove("paused");
      timerEl.style.setProperty("--progress-percent", percent + "%");
    } else {
      timerEl.title = "Ready to run (checking schedules...)";
      timerEl.classList.add("paused");
      timerEl.style.setProperty("--progress-percent", "100%");
    }
  }
  function startScheduleTimer() {
    updateScheduleTimer();
    if (scheduleTimerInterval) {
      clearInterval(scheduleTimerInterval);
    }
    scheduleTimerInterval = window.setInterval(() => {
      updateTimerDisplay();
      if (Date.now() % 3e4 < 1e3) {
        updateScheduleTimer();
      }
    }, 1e3);
  }
  function connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        console.log("WebSocket connected");
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "speedtest-complete") {
            Promise.all([
              loadSummary(),
              loadHistoryTable(),
              updateDownloadChart(),
              updateUploadChart(),
              updateLatencyChart(),
              updateJitterChart()
            ]).catch((err) => console.error("refresh after speedtest failed", err));
          } else if (data.type === "ping") {
          } else if (data.type === "status") {
          }
        } catch (err) {
          console.error("WebSocket message parse error:", err);
        }
      };
      ws.onerror = (error) => {
        console.error("WebSocket error:", error);
      };
      ws.onclose = () => {
        console.log("WebSocket disconnected, reconnecting...");
        ws = null;
        setTimeout(connectWebSocket, 2e3);
      };
    } catch (err) {
      console.error("Failed to create WebSocket:", err);
      setTimeout(connectWebSocket, 2e3);
    }
  }
  async function init() {
    setupNav();
    setupRunNow();
    setupScheduleForm();
    setupRangeSelectors();
    setupThemeSelection();
    startScheduleTimer();
    connectWebSocket();
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

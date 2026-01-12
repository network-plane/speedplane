type SpeedtestResult = {
  id: string;
  timestamp: string;
  download_mbps: number;
  upload_mbps: number;
  ping_ms: number;
  jitter_ms?: number;
  packet_loss_pct?: number;
  isp?: string;
  external_ip?: string;
  server_id?: string;
  server_name?: string;
  server_country?: string;
};

type Aggregate = {
  count: number;
  avg_download_mbps: number;
  avg_upload_mbps: number;
  avg_ping_ms: number;
  avg_jitter_ms: number;
  avg_packet_loss_pct: number;
};

type SummaryResponse = {
  latest?: SpeedtestResult;
  averages: Record<string, Aggregate>;
};

type Schedule = {
  id: string;
  name: string;
  type: "interval" | "daily";
  enabled: boolean;
  every?: string;
  time_of_day?: string;
};

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element #${id}`);
  }
  return el;
}

async function fetchJSON<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function formatNumber(val: number | undefined | null, digits = 2): string {
  if (val == null || Number.isNaN(val)) return "–";
  return val.toFixed(digits);
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime24h(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatDateTime(date: Date): string {
  return `${formatDate(date)} ${formatTime24h(date)}`;
}

/* ---------- SUMMARY CARDS ---------- */

async function loadSummary(): Promise<void> {
  const data = await fetchJSON<SummaryResponse>("/api/summary");

  // Check if a new result was added (for scheduled tests)
  if (data.latest && data.latest.timestamp) {
    if (lastResultTimestamp && lastResultTimestamp !== data.latest.timestamp) {
      // New result detected, refresh all charts
      await Promise.all([
        loadHistoryTable(),
        updateDownloadChart(),
        updateUploadChart(),
        updateLatencyChart(),
        updateJitterChart(),
      ]);
    }
    lastResultTimestamp = data.latest.timestamp;
  }

  if (data.latest) {
    $("latest-download-value").textContent = formatNumber(
      data.latest.download_mbps,
    );
    $("latest-download-sub").textContent = "Mbps";
    $("latest-upload-value").textContent = formatNumber(
      data.latest.upload_mbps,
    );
    $("latest-upload-sub").textContent = "Mbps";
    $("latest-ping-value").textContent = formatNumber(data.latest.ping_ms, 1);
    $("latest-ping-sub").textContent = "ms";
    $("latest-jitter-value").textContent = formatNumber(
      data.latest.jitter_ms ?? 0,
      1,
    );
    $("latest-jitter-sub").textContent = "ms";
    const packetLoss = data.latest.packet_loss_pct ?? -1;
    if (packetLoss < 0) {
      $("latest-packetloss-value").textContent = "—";
      $("latest-packetloss-sub").textContent = "";
    } else {
      $("latest-packetloss-value").textContent = formatNumber(packetLoss, 2);
      $("latest-packetloss-sub").textContent = "%";
    }
  }
}

/* ---------- HISTORY TABLE ---------- */

async function loadHistoryTable(): Promise<void> {
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const url =
    "/api/history?from=" +
    encodeURIComponent(from.toISOString()) +
    "&to=" +
    encodeURIComponent(now.toISOString());

  const rows = await fetchJSON<SpeedtestResult[]>(url);

  const tbody = $("history-table").querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  for (const r of rows) {
    const tr = document.createElement("tr");
    const serverInfo = r.server_name
      ? `${r.server_name}${r.server_country ? ` (${r.server_country})` : ""}${r.server_id ? ` [${r.server_id}]` : ""}`
      : r.server_id || "–";
    tr.innerHTML = `
      <td style="font-family: monospace; font-size: 11px;">${r.id.substring(0, 8)}</td>
      <td>${formatDateTime(new Date(r.timestamp))}</td>
      <td>${formatNumber(r.download_mbps)}</td>
      <td>${formatNumber(r.upload_mbps)}</td>
      <td>${formatNumber(r.ping_ms, 1)}</td>
      <td>${formatNumber(r.jitter_ms ?? 0, 1)}</td>
      <td>${
        (r.packet_loss_pct ?? -1) < 0
          ? "—"
          : formatNumber(r.packet_loss_pct ?? 0, 2)
      }</td>
      <td style="font-family: monospace; font-size: 12px;">${r.external_ip || "–"}</td>
      <td>${r.isp || "–"}</td>
      <td>${serverInfo}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* ---------- SIMPLE SVG LINE CHARTS ---------- */

type RangeKey = "24h" | "7d" | "30d";

function computeRange(range: RangeKey): { from: Date; to: Date } {
  const to = new Date();
  let days = 1;
  if (range === "7d") days = 7;
  if (range === "30d") days = 30;
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from, to };
}

async function loadHistoryForRange(range: RangeKey): Promise<SpeedtestResult[]> {
  const { from, to } = computeRange(range);
  const url =
    "/api/history?from=" +
    encodeURIComponent(from.toISOString()) +
    "&to=" +
    encodeURIComponent(to.toISOString());

  const rows = await fetchJSON<SpeedtestResult[]>(url);
  rows.sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  return rows;
}

function renderLineChart(
  containerId: string,
  rows: SpeedtestResult[],
  key: "download_mbps" | "upload_mbps" | "ping_ms" | "jitter_ms",
): void {
  const container = $(containerId);
  container.innerHTML = "";

  if (!rows.length) {
    container.textContent = "No data for selected range.";
    return;
  }

  const svgNS = "http://www.w3.org/2000/svg";
  // Use a wider aspect ratio to prevent horizontal stretching
  const width = 300;
  const height = 50;
  const paddingX = 12;
  const paddingY = 8;
  const paddingBottom = 12; // Space for x-axis labels

  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const times = rows.map((r) => new Date(r.timestamp).getTime());
  const values = rows.map((r) => {
    const val = (r as any)[key] as number;
    // Handle optional fields that might be undefined
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

  // Draw horizontal grid lines (dimmer white)
  const gridLines = 3;
  for (let i = 0; i <= gridLines; i++) {
    const yPos = paddingY + (innerH / gridLines) * i;
    const grid = document.createElementNS(svgNS, "line");
    grid.setAttribute("x1", paddingX.toString());
    grid.setAttribute("x2", (width - paddingX).toString());
    grid.setAttribute("y1", yPos.toString());
    grid.setAttribute("y2", yPos.toString());
    grid.setAttribute("stroke", "rgba(255,255,255,0.08)");
    grid.setAttribute("stroke-width", "0.3");
    svg.appendChild(grid);

    // Add bandwidth value labels on the left
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

  // Draw vertical lines for each test (dimmer)
  const coords = rows.map((r) => {
    const t = new Date(r.timestamp).getTime();
    const xNorm = maxX === minX ? 0 : (t - minX) / (maxX - minX);
    const v = (r as any)[key] as number;
    const yNorm = maxY === minY ? 0.5 : (v - minY) / (maxY - minY);
    const x = paddingX + xNorm * innerW;
    const y = paddingY + innerH - yNorm * innerH;
    return { x, y, time: t };
  });

  // Draw vertical lines for each test point
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

  // Draw the data line
  const path = document.createElementNS(svgNS, "path");
  const d = coords
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(" ");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "rgba(255,179,65,0.9)");
  path.setAttribute("stroke-width", "0.8");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("stroke-linecap", "round");
  svg.appendChild(path);

  // Draw data points
  coords.forEach((coord) => {
    const circle = document.createElementNS(svgNS, "circle");
    circle.setAttribute("cx", coord.x.toString());
    circle.setAttribute("cy", coord.y.toString());
    circle.setAttribute("r", "1.2");
    circle.setAttribute("fill", "#ffb341");
    svg.appendChild(circle);
  });

  // Add x-axis labels (time/date) - always use 24h format and YYYY-MM-DD
  const labelCount = Math.min(rows.length, 6); // Max 6 labels
  const labelStep = Math.max(1, Math.floor(rows.length / labelCount));
  for (let i = 0; i < rows.length; i += labelStep) {
    if (i >= coords.length) break;
    const coord = coords[i];
    const date = new Date(rows[i].timestamp);
    // Always show date in YYYY-MM-DD format and time in 24h format
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

function calculatePercentiles(values: number[]): {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  p10: number;
  p90: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const len = sorted.length;

  const percentile = (p: number): number => {
    if (len === 0) return 0;
    const index = (len - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index % 1;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  };

  return {
    min: sorted[0] ?? 0,
    p10: percentile(0.1),
    q1: percentile(0.25),
    median: percentile(0.5),
    q3: percentile(0.75),
    p90: percentile(0.9),
    max: sorted[len - 1] ?? 0,
  };
}

function renderPercentileChart(
  containerId: string,
  rows: SpeedtestResult[],
  key: "download_mbps" | "upload_mbps" | "ping_ms" | "jitter_ms",
): void {
  const container = $(containerId);
  container.innerHTML = "";

  if (!rows.length) {
    container.textContent = "No data for selected range.";
    return;
  }

  const values = rows.map((r) => {
    const val = (r as any)[key] as number;
    if (key === "jitter_ms") {
      return val ?? 0;
    }
    return val;
  }).filter(v => Number.isFinite(v));

  if (values.length === 0) {
    container.textContent = "No valid data.";
    return;
  }

  const stats = calculatePercentiles(values);
  const svgNS = "http://www.w3.org/2000/svg";
  const width = 300;
  const height = 50;
  const paddingX = 12;
  const paddingY = 8;
  const paddingBottom = 12;

  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  let minY = Math.min(stats.min, stats.p10);
  let maxY = Math.max(stats.max, stats.p90);
  if (minY === maxY) {
    const delta = minY === 0 ? 1 : minY * 0.1;
    minY -= delta;
    maxY += delta;
  }

  const innerW = width - paddingX * 2;
  const innerH = height - paddingY - paddingBottom;

  const yPos = (val: number): number => {
    const yNorm = maxY === minY ? 0.5 : (val - minY) / (maxY - minY);
    return paddingY + innerH - yNorm * innerH;
  };

  // Draw grid lines
  const gridLines = 3;
  for (let i = 0; i <= gridLines; i++) {
    const yPos = paddingY + (innerH / gridLines) * i;
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

  const centerX = width / 2;
  const boxWidth = innerW * 0.4;

  // Draw whiskers (min to p10, p90 to max)
  const whisker = (y1: number, y2: number, x: number) => {
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", x.toString());
    line.setAttribute("x2", x.toString());
    line.setAttribute("y1", y1.toString());
    line.setAttribute("y2", y2.toString());
    line.setAttribute("stroke", "rgba(255,255,255,0.5)");
    line.setAttribute("stroke-width", "0.4");
    svg.appendChild(line);
  };

  // Min to p10
  whisker(yPos(stats.min), yPos(stats.p10), centerX);
  // p90 to max
  whisker(yPos(stats.p90), yPos(stats.max), centerX);

  // Draw box (Q1 to Q3)
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

  // Draw median line
  const medianY = yPos(stats.median);
  const medianLine = document.createElementNS(svgNS, "line");
  medianLine.setAttribute("x1", (centerX - boxWidth / 2).toString());
  medianLine.setAttribute("x2", (centerX + boxWidth / 2).toString());
  medianLine.setAttribute("y1", medianY.toString());
  medianLine.setAttribute("y2", medianY.toString());
  medianLine.setAttribute("stroke", "#ffb341");
  medianLine.setAttribute("stroke-width", "1");
  svg.appendChild(medianLine);

  // Draw percentile markers
  const markers = [
    { val: stats.min, label: "Min", color: "rgba(255,255,255,0.6)" },
    { val: stats.p10, label: "P10", color: "rgba(255,255,255,0.5)" },
    { val: stats.q1, label: "Q1", color: "rgba(255,179,65,0.7)" },
    { val: stats.median, label: "Med", color: "#ffb341" },
    { val: stats.q3, label: "Q3", color: "rgba(255,179,65,0.7)" },
    { val: stats.p90, label: "P90", color: "rgba(255,255,255,0.5)" },
    { val: stats.max, label: "Max", color: "rgba(255,255,255,0.6)" },
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

  // Add statistics text
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

async function updateDownloadChart(): Promise<void> {
  const select = $("range-download") as HTMLSelectElement;
  const toggle = $("chart-type-download") as HTMLButtonElement;
  const value = (select.value || "24h") as RangeKey;
  const rows = await loadHistoryForRange(value);
  if (toggle?.classList.contains("active")) {
    renderPercentileChart("download-chart", rows, "download_mbps");
  } else {
    renderLineChart("download-chart", rows, "download_mbps");
  }
}

async function updateUploadChart(): Promise<void> {
  const select = $("range-upload") as HTMLSelectElement;
  const toggle = $("chart-type-upload") as HTMLButtonElement;
  const value = (select.value || "24h") as RangeKey;
  const rows = await loadHistoryForRange(value);
  if (toggle?.classList.contains("active")) {
    renderPercentileChart("upload-chart", rows, "upload_mbps");
  } else {
    renderLineChart("upload-chart", rows, "upload_mbps");
  }
}

async function updateLatencyChart(): Promise<void> {
  const select = $("range-latency") as HTMLSelectElement;
  const toggle = $("chart-type-latency") as HTMLButtonElement;
  const value = (select.value || "24h") as RangeKey;
  const rows = await loadHistoryForRange(value);
  if (toggle?.classList.contains("active")) {
    renderPercentileChart("latency-chart", rows, "ping_ms");
  } else {
    renderLineChart("latency-chart", rows, "ping_ms");
  }
}

async function updateJitterChart(): Promise<void> {
  const select = $("range-jitter") as HTMLSelectElement;
  const toggle = $("chart-type-jitter") as HTMLButtonElement;
  const value = (select.value || "24h") as RangeKey;
  const rows = await loadHistoryForRange(value);
  if (toggle?.classList.contains("active")) {
    renderPercentileChart("jitter-chart", rows, "jitter_ms");
  } else {
    renderLineChart("jitter-chart", rows, "jitter_ms");
  }
}

/* ---------- SCHEDULES ---------- */

let editingScheduleId: string | null = null;

async function loadSchedules(): Promise<void> {
  const scheds = await fetchJSON<Schedule[]>("/api/schedules");
  const list = $("schedules-list");
  list.innerHTML = "";

  // Refresh timer when schedules change
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
    detailsEl.textContent = `${typeText} • ${statusText}`;

    scheduleInfo.appendChild(nameEl);
    scheduleInfo.appendChild(detailsEl);

    const actions = document.createElement("div");
    actions.className = "schedule-actions";

    // Enable/Disable toggle
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "schedule-btn schedule-btn-toggle";
    toggleBtn.innerHTML = s.enabled ? "✓" : "○";
    toggleBtn.title = s.enabled ? "Disable" : "Enable";
    toggleBtn.addEventListener("click", async () => {
      const updated = { ...s, enabled: !s.enabled };
      try {
        await fetchJSON(`/api/schedules/${s.id}`, {
          method: "PUT",
          body: JSON.stringify(updated),
        });
        await loadSchedules();
      } catch (err) {
        console.error("toggle schedule failed", err);
      }
    });

    // Edit button
    const editBtn = document.createElement("button");
    editBtn.className = "schedule-btn schedule-btn-edit";
    editBtn.innerHTML = "✎";
    editBtn.title = "Edit";
    editBtn.addEventListener("click", () => {
      editingScheduleId = s.id;
      ($("schedule-form-id") as HTMLInputElement).value = s.id;
      ($("schedule-form-name") as HTMLInputElement).value = s.name || "";
      ($("schedule-form-type") as HTMLSelectElement).value = s.type;
      ($("schedule-form-every") as HTMLInputElement).value = s.every || "";
      ($("schedule-form-timeOfDay") as HTMLInputElement).value = s.time_of_day || "";
      ($("schedule-form-enabled") as HTMLInputElement).checked = s.enabled;
      ($("schedule-form-submit") as HTMLButtonElement).textContent = "Update";
      toggleScheduleFields(s.type);
      ($("schedule-form-cancel") as HTMLButtonElement).style.display = "inline-block";
      // Scroll to form
      document.getElementById("schedule-form")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    // Delete button
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "schedule-btn schedule-btn-delete";
    deleteBtn.innerHTML = "🗑";
    deleteBtn.title = "Delete";
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Delete schedule "${s.name || s.id}"?`)) return;
      try {
        await fetchJSON(`/api/schedules/${s.id}`, {
          method: "DELETE",
        });
        // Remove the card immediately for better UX
        card.remove();
        // Also reload to ensure consistency
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

/* ---------- NAV ---------- */

function setupNav(): void {
  // Sidebar toggle functionality
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

  const buttons = document.querySelectorAll<HTMLButtonElement>(".nav-item");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      // Expand sidebar when nav item is clicked (if collapsed)
      if (sidebar && sidebar.classList.contains("collapsed")) {
        sidebar.classList.remove("collapsed");
        localStorage.setItem("sidebar-expanded", "true");
      }

      const view = btn.dataset.view;
      if (!view) return;

      buttons.forEach((b) => b.classList.remove("nav-item-active"));
      btn.classList.add("nav-item-active");

      document
        .querySelectorAll<HTMLElement>(".view")
        .forEach((v) => v.classList.remove("view-active"));
      const el = document.getElementById(`view-${view}`);
      if (el) el.classList.add("view-active");
    });
  });
}

/* ---------- RUN NOW ---------- */

function setupRunNow(): void {
  const btn = document.getElementById("run-now-btn") as HTMLButtonElement | null;
  if (!btn) return;

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Starting...";

    // Show progress modal
    const modal = showProgressModal();
    const statusEl = modal.querySelector(".progress-status") as HTMLElement;
    const messageEl = modal.querySelector(".progress-message") as HTMLElement;

    try {
      const result = await runSpeedtestWithProgress((stage: string, message: string) => {
        if (statusEl) statusEl.textContent = stage;
        if (messageEl) messageEl.textContent = message;
        btn.textContent = message;
      });

      // Close modal and refresh data
      closeProgressModal(modal);
      await Promise.all([
        loadSummary(),
        loadHistoryTable(),
        updateDownloadChart(),
        updateUploadChart(),
        updateLatencyChart(),
        updateJitterChart(),
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

function showProgressModal(): HTMLElement {
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

function closeProgressModal(modal: HTMLElement): void {
  if (modal && modal.parentNode) {
    modal.parentNode.removeChild(modal);
  }
}

async function runSpeedtestWithProgress(
  onProgress: (stage: string, message: string) => void
): Promise<any> {
  return new Promise((resolve, reject) => {
    fetch("/api/run/stream", { method: "POST" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        if (!response.body) {
          throw new Error("Response body is null");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        function processChunk(): Promise<void> {
          return reader.read().then(({ done, value }) => {
            if (done) {
              if (buffer.trim()) {
                // Process remaining buffer
                const lines = buffer.split("\n");
                for (const line of lines) {
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
                    // Initial message, ignore
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
      })
      .catch(reject);
  });
}

/* ---------- SCHEDULE FORM ---------- */

function toggleScheduleFields(type: string): void {
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

function setupScheduleForm(): void {
  const form = document.getElementById("schedule-form") as HTMLFormElement | null;
  if (!form) return;

  const typeSelect = $("schedule-form-type") as HTMLSelectElement;
  typeSelect.addEventListener("change", () => {
    toggleScheduleFields(typeSelect.value);
  });

  // Initialize fields based on default type
  toggleScheduleFields(typeSelect.value);

  const cancelBtn = $("schedule-form-cancel") as HTMLButtonElement;
  cancelBtn.addEventListener("click", () => {
    editingScheduleId = null;
    form.reset();
    ($("schedule-form-id") as HTMLInputElement).value = "";
    ($("schedule-form-enabled") as HTMLInputElement).checked = true;
    ($("schedule-form-submit") as HTMLButtonElement).textContent = "Add";
    cancelBtn.style.display = "none";
    toggleScheduleFields(typeSelect.value);
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();

    const data = new FormData(form);
    const id = (data.get("id") as string) || "";
    const payload: any = {
      name: data.get("name") || "",
      type: data.get("type") || "interval",
      enabled: data.get("enabled") === "on",
      every: data.get("every") || "",
      time_of_day: data.get("timeOfDay") || "",
    };

    try {
      if (editingScheduleId) {
        // Update existing
        await fetchJSON(`/api/schedules/${editingScheduleId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      } else {
        // Create new
        await fetchJSON("/api/schedules", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      form.reset();
      ($("schedule-form-id") as HTMLInputElement).value = "";
      ($("schedule-form-enabled") as HTMLInputElement).checked = true;
      ($("schedule-form-submit") as HTMLButtonElement).textContent = "Add";
      cancelBtn.style.display = "none";
      editingScheduleId = null;
      await loadSchedules();
    } catch (err) {
      console.error("save schedule failed", err);
    }
  });
}

/* ---------- RANGE DROPDOWNS ---------- */

function setupRangeSelectors(): void {
  const d = $("range-download") as HTMLSelectElement;
  const u = $("range-upload") as HTMLSelectElement;
  const l = $("range-latency") as HTMLSelectElement;
  const j = $("range-jitter") as HTMLSelectElement;

  const dt = $("chart-type-download") as HTMLButtonElement;
  const ut = $("chart-type-upload") as HTMLButtonElement;
  const lt = $("chart-type-latency") as HTMLButtonElement;
  const jt = $("chart-type-jitter") as HTMLButtonElement;

  d.addEventListener("change", () => {
    updateDownloadChart().catch((err) =>
      console.error("updateDownloadChart", err),
    );
  });
  u.addEventListener("change", () => {
    updateUploadChart().catch((err) =>
      console.error("updateUploadChart", err),
    );
  });
  l.addEventListener("change", () => {
    updateLatencyChart().catch((err) =>
      console.error("updateLatencyChart", err),
    );
  });
  j.addEventListener("change", () => {
    updateJitterChart().catch((err) =>
      console.error("updateJitterChart", err),
    );
  });

  dt?.addEventListener("click", () => {
    dt.classList.toggle("active");
    updateDownloadChart().catch((err) =>
      console.error("updateDownloadChart", err),
    );
  });
  ut?.addEventListener("click", () => {
    ut.classList.toggle("active");
    updateUploadChart().catch((err) =>
      console.error("updateUploadChart", err),
    );
  });
  lt?.addEventListener("click", () => {
    lt.classList.toggle("active");
    updateLatencyChart().catch((err) =>
      console.error("updateLatencyChart", err),
    );
  });
  jt?.addEventListener("click", () => {
    jt.classList.toggle("active");
    updateJitterChart().catch((err) =>
      console.error("updateJitterChart", err),
    );
  });
}

/* ---------- THEME SELECTION ---------- */

async function loadSchemesForTemplate(templateName: string): Promise<void> {
  const schemeSelect = $("pref-scheme") as HTMLSelectElement;
  const currentScheme = localStorage.getItem("scheme") || "default";

  try {
    const schemes = await fetchJSON<
      Array<{ name: string; display: string; accent: string; border: boolean }>
    >(`/api/schemes?template=${encodeURIComponent(templateName)}`);

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

async function applyTheme(templateName: string, schemeName: string): Promise<void> {
  try {
    const response = await fetch(
      `/api/theme?template=${encodeURIComponent(templateName)}&scheme=${encodeURIComponent(schemeName)}`,
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

function setupThemeSelection(): void {
  const templateSelect = $("pref-template") as HTMLSelectElement;
  const schemeSelect = $("pref-scheme") as HTMLSelectElement;

  // Set current values from localStorage or HTML attributes
  const savedTemplate = localStorage.getItem("template");
  const savedScheme = localStorage.getItem("scheme");
  const htmlTemplate = document.documentElement.getAttribute("data-template");
  const htmlScheme = document.documentElement.getAttribute("data-scheme");

  const currentTemplate = savedTemplate || htmlTemplate || "speedplane";
  const currentScheme = savedScheme || htmlScheme || "default";

  // Set template select value if it exists in the options
  if (Array.from(templateSelect.options).some((opt) => opt.value === currentTemplate)) {
    templateSelect.value = currentTemplate;
  }
  loadSchemesForTemplate(currentTemplate).catch((err) =>
    console.error("loadSchemesForTemplate", err),
  );

  templateSelect.addEventListener("change", async () => {
    const newTemplate = templateSelect.value;
    // Reset to default scheme when template changes
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

/* ---------- SCHEDULE TIMER ---------- */

let scheduleTimerInterval: number | null = null;
let nextRunTime: number | null = null;
let intervalDuration: number | null = null;
let lastResultTimestamp: string | null = null;
let resultPollInterval: number | null = null;

async function updateScheduleTimer(): Promise<void> {
  try {
    const data = await fetchJSON<{
      next_run: string | null;
      remaining: number;
      timestamp: number;
    }>("/api/next-run");

    const timerEl = document.getElementById("schedule-timer");
    if (!timerEl) return;

    if (!data.next_run) {
      timerEl.style.display = "none";
      if (scheduleTimerInterval) {
        clearInterval(scheduleTimerInterval);
        scheduleTimerInterval = null;
      }
      return;
    }

    timerEl.style.display = "block";
    nextRunTime = new Date(data.next_run).getTime();
    intervalDuration = data.remaining * 1000;
    updateTimerDisplay();
  } catch (err) {
    console.error("Failed to fetch next run time:", err);
  }
}

function updateTimerDisplay(): void {
  const timerEl = document.getElementById("schedule-timer");
  if (!timerEl || !nextRunTime || !intervalDuration) return;

  const now = Date.now();
  const elapsed = now - (nextRunTime - intervalDuration);
  const remaining = Math.max(0, nextRunTime - now);
  const percent = Math.min(100, Math.max(0, (elapsed / intervalDuration) * 100));

  const totalSeconds = Math.ceil(remaining / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
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

function startScheduleTimer(): void {
  updateScheduleTimer();
  if (scheduleTimerInterval) {
    clearInterval(scheduleTimerInterval);
  }
  scheduleTimerInterval = window.setInterval(() => {
    updateTimerDisplay();
    // Refresh next run time every 30 seconds
    if (Date.now() % 30000 < 1000) {
      updateScheduleTimer();
    }
  }, 1000);
}

function startResultPolling(): void {
  // Poll for new results every 10 seconds to detect scheduled speedtests
  if (resultPollInterval) {
    clearInterval(resultPollInterval);
  }
  resultPollInterval = window.setInterval(() => {
    loadSummary().catch((err) => console.error("poll summary failed", err));
  }, 10000);
}

/* ---------- INIT ---------- */

async function init(): Promise<void> {
  setupNav();
  setupRunNow();
  setupScheduleForm();
  setupRangeSelectors();
  setupThemeSelection();
  startScheduleTimer();
  startResultPolling();

  await Promise.all([
    loadSummary(),
    loadHistoryTable(),
    loadSchedules(),
    updateDownloadChart(),
    updateUploadChart(),
    updateLatencyChart(),
    updateJitterChart(),
  ]);
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => console.error(err));
});

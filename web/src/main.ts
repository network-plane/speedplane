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
    $("latest-packetloss-value").textContent = formatNumber(
      data.latest.packet_loss_pct ?? 0,
      2,
    );
    $("latest-packetloss-sub").textContent = "%";
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
      <td>${formatNumber(r.packet_loss_pct ?? 0, 2)}</td>
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

async function updateDownloadChart(): Promise<void> {
  const select = $("range-download") as HTMLSelectElement;
  const value = (select.value || "24h") as RangeKey;
  const rows = await loadHistoryForRange(value);
  renderLineChart("download-chart", rows, "download_mbps");
}

async function updateUploadChart(): Promise<void> {
  const select = $("range-upload") as HTMLSelectElement;
  const value = (select.value || "24h") as RangeKey;
  const rows = await loadHistoryForRange(value);
  renderLineChart("upload-chart", rows, "upload_mbps");
}

async function updateLatencyChart(): Promise<void> {
  const select = $("range-latency") as HTMLSelectElement;
  const value = (select.value || "24h") as RangeKey;
  const rows = await loadHistoryForRange(value);
  renderLineChart("latency-chart", rows, "ping_ms");
}

async function updateJitterChart(): Promise<void> {
  const select = $("range-jitter") as HTMLSelectElement;
  const value = (select.value || "24h") as RangeKey;
  const rows = await loadHistoryForRange(value);
  renderLineChart("jitter-chart", rows, "jitter_ms");
}

/* ---------- SCHEDULES ---------- */

let editingScheduleId: string | null = null;

async function loadSchedules(): Promise<void> {
  const scheds = await fetchJSON<Schedule[]>("/api/schedules");
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
      ($("schedule-form-submit") as HTMLButtonElement).textContent = "Update schedule";
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

/* ---------- NAV ---------- */

function setupNav(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".nav-item");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
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
    btn.textContent = "Running...";
    try {
      await fetchJSON("/api/run", { method: "POST" });
      await Promise.all([
        loadSummary(),
        loadHistoryTable(),
        updateDownloadChart(),
        updateUploadChart(),
      ]);
    } catch (err) {
      console.error("run-now failed", err);
    } finally {
      btn.disabled = false;
      btn.textContent = "Run speedtest now";
    }
  });
}

/* ---------- SCHEDULE FORM ---------- */

function setupScheduleForm(): void {
  const form = document.getElementById("schedule-form") as HTMLFormElement | null;
  if (!form) return;

  const cancelBtn = $("schedule-form-cancel") as HTMLButtonElement;
  cancelBtn.addEventListener("click", () => {
    editingScheduleId = null;
    form.reset();
    ($("schedule-form-id") as HTMLInputElement).value = "";
    ($("schedule-form-enabled") as HTMLInputElement).checked = true;
    ($("schedule-form-submit") as HTMLButtonElement).textContent = "Add schedule";
    cancelBtn.style.display = "none";
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
      ($("schedule-form-submit") as HTMLButtonElement).textContent = "Add schedule";
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
}

/* ---------- INIT ---------- */

async function init(): Promise<void> {
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
    updateJitterChart(),
  ]);
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => console.error(err));
});

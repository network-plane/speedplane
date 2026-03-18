import {
  fetchJSON,
  formatNumber,
  formatDateTime,
  renderLineChart,
  renderCombinedChart,
  renderPercentileChart as pwRenderPercentile,
  SPEEDPLANE_COMBINED_SERIES,
  speedtestRowToTimeSeries,
  DEFAULT_PAN_WINDOW_FRACTION,
  type RangeKey,
  type ChartPanState,
} from "../../../packages/planeweb/src/index.ts";

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

/* ---------- SUMMARY CARDS ---------- */

function updateComparison(
  compareEl: HTMLElement,
  latest: number,
  average: number,
  isLowerBetter: boolean
): void {
  if (!average || average === 0 || !latest || latest < 0) {
    compareEl.textContent = "";
    compareEl.className = "card-compare";
    return;
  }

  const percentDiff = ((latest - average) / average) * 100;
  const absPercent = Math.abs(percentDiff);

  if (absPercent < 0.1) {
    // Less than 0.1% difference, consider it the same
    compareEl.textContent = "";
    compareEl.className = "card-compare";
    return;
  }

  let isSlower: boolean;
  if (isLowerBetter) {
    // For ping, jitter, packet loss: higher is worse
    isSlower = percentDiff > 0;
  } else {
    // For download, upload: lower is worse
    isSlower = percentDiff < 0;
  }

  const arrow = isSlower
    ? (isLowerBetter ? "↑" : "↓")
    : (isLowerBetter ? "↓" : "↑");
  const text = isSlower ? "slower" : "faster";
  const className = isSlower ? "card-compare slower" : "card-compare faster";

  compareEl.className = className;
  compareEl.innerHTML = `<span class="arrow">${arrow}</span> ${formatNumber(absPercent, 2)}% ${text}`;
}

async function loadSummary(): Promise<void> {
  const data = await fetchJSON<SummaryResponse>("/api/summary");

  if (data.latest) {
    $("latest-download-value").textContent = formatNumber(
      data.latest.download_mbps,
    );
    $("latest-upload-value").textContent = formatNumber(
      data.latest.upload_mbps,
    );
    $("latest-ping-value").textContent = formatNumber(data.latest.ping_ms, 1);
    $("latest-jitter-value").textContent = formatNumber(
      data.latest.jitter_ms ?? 0,
      1,
    );
    const packetLoss = data.latest.packet_loss_pct ?? -1;
    if (packetLoss < 0) {
      $("latest-packetloss-value").textContent = "—";
    } else {
      $("latest-packetloss-value").textContent = formatNumber(packetLoss, 2);
    }

    // Update comparison indicators
    const avg30 = data.averages["last30days"];
    if (avg30) {
      updateComparison(
        $("latest-download-compare"),
        data.latest.download_mbps,
        avg30.avg_download_mbps,
        false // Higher is better
      );
      updateComparison(
        $("latest-upload-compare"),
        data.latest.upload_mbps,
        avg30.avg_upload_mbps,
        false // Higher is better
      );
      updateComparison(
        $("latest-ping-compare"),
        data.latest.ping_ms,
        avg30.avg_ping_ms,
        true // Lower is better
      );
      if (data.latest.jitter_ms !== undefined && data.latest.jitter_ms >= 0) {
        updateComparison(
          $("latest-jitter-compare"),
          data.latest.jitter_ms,
          avg30.avg_jitter_ms,
          true // Lower is better
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
          true // Lower is better
        );
      } else {
        $("latest-packetloss-compare").textContent = "";
        $("latest-packetloss-compare").className = "card-compare";
      }
    }
  }
}

/* ---------- HISTORY TABLE ---------- */

type HistoryPageResponse = {
  results: SpeedtestResult[];
  total: number;
};

let historyCurrentPage = 1;
let historyTotal = 0;
let historyPerPage = 100;

function getHistoryPageCount(): number {
  if (historyPerPage <= 0) return 1;
  return Math.max(1, Math.ceil(historyTotal / historyPerPage));
}

async function loadHistoryTable(): Promise<void> {
  const perPage = historyPerPage;
  const offset = (historyCurrentPage - 1) * perPage;
  const url = `/api/history?range=all&limit=${perPage}&offset=${offset}`;

  const data = await fetchJSON<HistoryPageResponse>(url);
  const rows = data.results;
  historyTotal = data.total;

  // If current page is beyond last page (e.g. after delete), go to last page and refetch
  const totalPages = getHistoryPageCount();
  if (totalPages >= 1 && historyCurrentPage > totalPages) {
    historyCurrentPage = totalPages;
    return loadHistoryTable();
  }

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
      <td>
        <button class="btn delete-result-btn" data-result-id="${r.id}" style="padding: 4px 8px; font-size: 12px; background-color: #dc3545; color: white; border: none;">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  // Attach delete event listeners
  const deleteButtons = tbody.querySelectorAll(".delete-result-btn");
  deleteButtons.forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const button = e.target as HTMLButtonElement;
      const id = button.getAttribute("data-result-id");
      if (id) {
        await deleteResult(id);
      }
    });
  });

  // Update pagination controls
  updateHistoryPagination();
}

function updateHistoryPagination(): void {
  const totalPages = getHistoryPageCount();
  const pageInfo = $("history-page-info");
  pageInfo.textContent = `Page ${historyCurrentPage} of ${totalPages}${historyTotal > 0 ? ` (${historyTotal} total)` : ""}`;

  const firstBtn = document.getElementById("history-page-first") as HTMLButtonElement;
  const prevBtn = document.getElementById("history-page-prev") as HTMLButtonElement;
  const nextBtn = document.getElementById("history-page-next") as HTMLButtonElement;
  const lastBtn = document.getElementById("history-page-last") as HTMLButtonElement;

  if (firstBtn) firstBtn.disabled = historyCurrentPage <= 1;
  if (prevBtn) prevBtn.disabled = historyCurrentPage <= 1;
  if (nextBtn) nextBtn.disabled = historyCurrentPage >= totalPages || totalPages <= 1;
  if (lastBtn) lastBtn.disabled = historyCurrentPage >= totalPages || totalPages <= 1;
}

function setupHistoryPagination(): void {
  const perPageSelect = document.getElementById("history-per-page") as HTMLSelectElement;
  const firstBtn = document.getElementById("history-page-first");
  const prevBtn = document.getElementById("history-page-prev");
  const nextBtn = document.getElementById("history-page-next");
  const lastBtn = document.getElementById("history-page-last");

  const savedPerPage = localStorage.getItem("history-per-page");
  if (savedPerPage && ["50", "100", "200"].includes(savedPerPage)) {
    historyPerPage = parseInt(savedPerPage, 10);
    if (perPageSelect) perPageSelect.value = savedPerPage;
  }

  perPageSelect?.addEventListener("change", () => {
    historyPerPage = parseInt(perPageSelect.value, 10);
    localStorage.setItem("history-per-page", perPageSelect.value);
    historyCurrentPage = 1;
    loadHistoryTable().catch((err) => console.error("loadHistoryTable", err));
  });

  firstBtn?.addEventListener("click", () => {
    historyCurrentPage = 1;
    loadHistoryTable().catch((err) => console.error("loadHistoryTable", err));
  });
  prevBtn?.addEventListener("click", () => {
    if (historyCurrentPage > 1) {
      historyCurrentPage--;
      loadHistoryTable().catch((err) => console.error("loadHistoryTable", err));
    }
  });
  nextBtn?.addEventListener("click", () => {
    if (historyCurrentPage < getHistoryPageCount()) {
      historyCurrentPage++;
      loadHistoryTable().catch((err) => console.error("loadHistoryTable", err));
    }
  });
  lastBtn?.addEventListener("click", () => {
    historyCurrentPage = getHistoryPageCount();
    loadHistoryTable().catch((err) => console.error("loadHistoryTable", err));
  });
}

async function deleteResult(id: string): Promise<void> {
  if (!confirm("Are you sure you want to delete this result?")) {
    return;
  }

  try {
    const response = await fetch(`/api/results/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      if (response.status === 404) {
        alert("Result not found");
      } else {
        alert("Failed to delete result");
      }
      return;
    }

    // Reload the history table and refresh charts
    const isCombinedGraph = localStorage.getItem("combined-graph") === "true";
    const chartPromises = isCombinedGraph
      ? [updateCombinedChart()]
      : [
          updateDownloadChart(),
          updateUploadChart(),
          updateLatencyChart(),
          updateJitterChart(),
        ];

    await Promise.all([
      loadSummary(),
      loadHistoryTable(),
      ...chartPromises,
    ]);
  } catch (err) {
    console.error("Delete result error:", err);
    alert("Failed to delete result");
  }
}

/* ---------- SIMPLE SVG LINE CHARTS ---------- */

async function loadHistoryForRange(range: RangeKey): Promise<SpeedtestResult[]> {
  const url = "/api/history?range=" + encodeURIComponent(range);
  return await fetchJSON<SpeedtestResult[]>(url);
}

type ChartDataResponse = {
  data: SpeedtestResult[];
  stats?: {
    min: number;
    p10: number;
    q1: number;
    median: number;
    q3: number;
    p90: number;
    max: number;
  };
  min_value: number;
  max_value: number;
};

async function loadChartData(
  range: RangeKey,
  metric: "download" | "upload" | "ping" | "jitter"
): Promise<ChartDataResponse> {
  const url =
    "/api/chart-data?range=" +
    encodeURIComponent(range) +
    "&metric=" +
    encodeURIComponent(metric);
  return await fetchJSON<ChartDataResponse>(url);
}

let chartPanState: ChartPanState = { offset: 0, windowFraction: DEFAULT_PAN_WINDOW_FRACTION };
const chartFullDataByRange: Partial<Record<RangeKey, SpeedtestResult[]>> = {};
let chartLastRange: RangeKey | null = null;

function getChartPanOpts(range: RangeKey): { range: RangeKey; pan: ChartPanState; onPanChange: () => void } {
  if (range !== chartLastRange) {
    chartPanState.offset = 0;
    chartLastRange = range;
  }
  return { range, pan: chartPanState, onPanChange: refreshDashboardCharts };
}

function lineMetricMeta(
  key: "download_mbps" | "upload_mbps" | "ping_ms" | "jitter_ms",
): { name: string; unit: string } {
  switch (key) {
    case "download_mbps":
      return { name: "Download", unit: "Mbps" };
    case "upload_mbps":
      return { name: "Upload", unit: "Mbps" };
    case "ping_ms":
      return { name: "Ping", unit: "ms" };
    case "jitter_ms":
      return { name: "Jitter", unit: "ms" };
  }
}

function refreshDashboardCharts(): void {
  const isCombined = localStorage.getItem("combined-graph") === "true";
  const panOptsBase = { pan: chartPanState, onPanChange: refreshDashboardCharts, skipPanSetup: true };
  if (isCombined) {
    const range = (($("range-combined") as HTMLSelectElement)?.value || "24h") as RangeKey;
    const rows = chartFullDataByRange[range];
    if (rows) {
      renderCombinedChart(
        "combined-chart",
        rows.map(speedtestRowToTimeSeries),
        SPEEDPLANE_COMBINED_SERIES,
        { ...panOptsBase, range },
      );
    }
  } else {
    const charts: {
      id: string;
      key: "download_mbps" | "upload_mbps" | "ping_ms" | "jitter_ms";
      rangeSelectId: string;
      toggleId: string;
      metric: "download" | "upload" | "ping" | "jitter";
    }[] = [
      { id: "download-chart", key: "download_mbps", rangeSelectId: "range-download", toggleId: "chart-type-download", metric: "download" },
      { id: "upload-chart", key: "upload_mbps", rangeSelectId: "range-upload", toggleId: "chart-type-upload", metric: "upload" },
      { id: "latency-chart", key: "ping_ms", rangeSelectId: "range-latency", toggleId: "chart-type-latency", metric: "ping" },
      { id: "jitter-chart", key: "jitter_ms", rangeSelectId: "range-jitter", toggleId: "chart-type-jitter", metric: "jitter" },
    ];
    for (const c of charts) {
      const range = (document.getElementById(c.rangeSelectId) as HTMLSelectElement)?.value as RangeKey | undefined;
      if (!range) continue;
      const toggle = document.getElementById(c.toggleId);
      const isPercentile = toggle?.classList.contains("active");
      if (isPercentile) {
        renderPercentileChart(c.id, range, c.metric).catch((err) => console.error("renderPercentileChart", err));
      } else {
        const rows = range ? chartFullDataByRange[range] : undefined;
        if (rows) {
          const m = lineMetricMeta(c.key);
          renderLineChart(c.id, rows.map(speedtestRowToTimeSeries), c.key, {
            ...panOptsBase,
            range,
            metricName: m.name,
            metricUnit: m.unit,
          });
        }
      }
    }
  }
}

async function renderPercentileChart(
  containerId: string,
  range: RangeKey,
  metric: "download" | "upload" | "ping" | "jitter",
): Promise<void> {
  const container = $(containerId);
  const prevPan = (container as HTMLElement & { __panAbort?: AbortController }).__panAbort;
  if (prevPan) prevPan.abort();
  container.innerHTML = "";
  container.title = "";
  container.style.cursor = "";

  const chartData = await loadChartData(range, metric);
  if (!chartData.data.length || !chartData.stats) {
    container.textContent = "No data for selected range.";
    return;
  }
  const meta =
    metric === "download"
      ? { n: "Download", u: "Mbps" }
      : metric === "upload"
        ? { n: "Upload", u: "Mbps" }
        : metric === "ping"
          ? { n: "Ping", u: "ms" }
          : { n: "Jitter", u: "ms" };
  pwRenderPercentile(containerId, chartData.stats, meta.n, meta.u);
}

async function updateDownloadChart(): Promise<void> {
  const select = $("range-download") as HTMLSelectElement;
  const toggle = $("chart-type-download") as HTMLButtonElement;
  const value = (select.value || "24h") as RangeKey;
  if (toggle?.classList.contains("active")) {
    await renderPercentileChart("download-chart", value, "download");
  } else {
    const rows = await loadHistoryForRange(value);
    chartFullDataByRange[value] = rows;
    renderLineChart("download-chart", rows.map(speedtestRowToTimeSeries), "download_mbps", {
      ...getChartPanOpts(value),
      metricName: "Download",
      metricUnit: "Mbps",
    });
  }
}

async function updateUploadChart(): Promise<void> {
  const select = $("range-upload") as HTMLSelectElement;
  const toggle = $("chart-type-upload") as HTMLButtonElement;
  const value = (select.value || "24h") as RangeKey;
  if (toggle?.classList.contains("active")) {
    await renderPercentileChart("upload-chart", value, "upload");
  } else {
    const rows = await loadHistoryForRange(value);
    chartFullDataByRange[value] = rows;
    renderLineChart("upload-chart", rows.map(speedtestRowToTimeSeries), "upload_mbps", {
      ...getChartPanOpts(value),
      metricName: "Upload",
      metricUnit: "Mbps",
    });
  }
}

async function updateLatencyChart(): Promise<void> {
  const select = $("range-latency") as HTMLSelectElement;
  const toggle = $("chart-type-latency") as HTMLButtonElement;
  const value = (select.value || "24h") as RangeKey;
  if (toggle?.classList.contains("active")) {
    await renderPercentileChart("latency-chart", value, "ping");
  } else {
    const rows = await loadHistoryForRange(value);
    chartFullDataByRange[value] = rows;
    renderLineChart("latency-chart", rows.map(speedtestRowToTimeSeries), "ping_ms", {
      ...getChartPanOpts(value),
      metricName: "Ping",
      metricUnit: "ms",
    });
  }
}

async function updateJitterChart(): Promise<void> {
  const select = $("range-jitter") as HTMLSelectElement;
  const toggle = $("chart-type-jitter") as HTMLButtonElement;
  const value = (select.value || "24h") as RangeKey;
  if (toggle?.classList.contains("active")) {
    await renderPercentileChart("jitter-chart", value, "jitter");
  } else {
    const rows = await loadHistoryForRange(value);
    chartFullDataByRange[value] = rows;
    renderLineChart("jitter-chart", rows.map(speedtestRowToTimeSeries), "jitter_ms", {
      ...getChartPanOpts(value),
      metricName: "Jitter",
      metricUnit: "ms",
    });
  }
}

async function updateCombinedChart(): Promise<void> {
  const select = $("range-combined") as HTMLSelectElement;
  const value = (select.value || "24h") as RangeKey;
  localStorage.setItem("chart-range-combined", value);
  const rows = await loadHistoryForRange(value);
  chartFullDataByRange[value] = rows;
  renderCombinedChart(
    "combined-chart",
    rows.map(speedtestRowToTimeSeries),
    SPEEDPLANE_COMBINED_SERIES,
    getChartPanOpts(value),
  );
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

let sidebarManuallyToggled = false;
let autoCollapseTimeout: number | null = null;
const AUTO_COLLAPSE_DELAY = 3000; // 3 seconds after last interaction
const HOVER_EXPAND_DELAY = 3000; // 3 seconds to expand on hover

function setupNav(): void {
  // Sidebar toggle functionality
  const sidebar = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const isExpanded = localStorage.getItem("sidebar-expanded") === "true";

  // Check if sidebar was manually toggled (stored in sessionStorage to persist across page loads)
  sidebarManuallyToggled = sessionStorage.getItem("sidebar-manually-toggled") === "true";

  if (sidebar) {
    if (isExpanded && sidebarManuallyToggled) {
      sidebar.classList.remove("collapsed");
    } else {
      sidebar.classList.add("collapsed");
      // If not manually toggled, ensure it starts collapsed
      if (!sidebarManuallyToggled) {
        localStorage.setItem("sidebar-expanded", "false");
      }
    }

    if (sidebarToggle) {
      sidebarToggle.addEventListener("click", () => {
        sidebarManuallyToggled = true;
        sessionStorage.setItem("sidebar-manually-toggled", "true");
        sidebar.classList.toggle("collapsed");
        const expanded = !sidebar.classList.contains("collapsed");
        localStorage.setItem("sidebar-expanded", String(expanded));
        // Cancel auto-collapse when manually toggled
        if (autoCollapseTimeout) {
          clearTimeout(autoCollapseTimeout);
          autoCollapseTimeout = null;
        }
        // If manually collapsed, reset the flag
        if (!expanded) {
          sidebarManuallyToggled = false;
          sessionStorage.removeItem("sidebar-manually-toggled");
        }
      });
    }

    // Auto-collapse functionality - only if not manually toggled
    if (!sidebarManuallyToggled) {
      scheduleAutoCollapse();
    }

    // Auto-expand sidebar on hover after 3 seconds (when collapsed)
    let sidebarHoverTimeout: number | null = null;

    sidebar.addEventListener("mouseenter", () => {
      // Cancel auto-collapse
      if (autoCollapseTimeout) {
        clearTimeout(autoCollapseTimeout);
        autoCollapseTimeout = null;
      }
      // Auto-expand if collapsed
      if (sidebar.classList.contains("collapsed")) {
        sidebarHoverTimeout = window.setTimeout(() => {
          if (sidebar && sidebar.classList.contains("collapsed")) {
            sidebar.classList.remove("collapsed");
            localStorage.setItem("sidebar-expanded", "true");
            // Don't set sidebarManuallyToggled - this was expanded via hover, so it should auto-collapse
          }
          sidebarHoverTimeout = null;
        }, HOVER_EXPAND_DELAY);
      }
    });

    sidebar.addEventListener("mouseleave", () => {
      // Cancel hover expand timeout
      if (sidebarHoverTimeout) {
        clearTimeout(sidebarHoverTimeout);
        sidebarHoverTimeout = null;
      }
      // Schedule auto-collapse if expanded and not manually toggled
      if (!sidebar.classList.contains("collapsed") && !sidebarManuallyToggled) {
        scheduleAutoCollapse();
      }
    });

    // Auto-collapse when clicking outside the sidebar
    document.addEventListener("click", (e) => {
      if (!sidebarManuallyToggled && sidebar && !sidebar.classList.contains("collapsed")) {
        const target = e.target as HTMLElement;
        // Don't collapse if clicking on sidebar or toggle button
        if (!sidebar.contains(target) && target !== sidebarToggle && !sidebarToggle?.contains(target)) {
          scheduleAutoCollapse();
        }
      }
    });
  }

  const buttons = document.querySelectorAll<HTMLButtonElement>(".nav-item");

  buttons.forEach((btn) => {
    let hoverTimeout: number | null = null;

    // Auto-expand sidebar on hover after 3 seconds
    btn.addEventListener("mouseenter", () => {
      if (sidebar && sidebar.classList.contains("collapsed")) {
        hoverTimeout = window.setTimeout(() => {
          if (sidebar && sidebar.classList.contains("collapsed")) {
            sidebar.classList.remove("collapsed");
            localStorage.setItem("sidebar-expanded", "true");
            // Don't set sidebarManuallyToggled - this was expanded via hover, so it should auto-collapse
            // Cancel any pending auto-collapse
            if (autoCollapseTimeout) {
              clearTimeout(autoCollapseTimeout);
              autoCollapseTimeout = null;
            }
          }
          hoverTimeout = null;
        }, HOVER_EXPAND_DELAY);
      }
    });

    btn.addEventListener("mouseleave", () => {
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
        hoverTimeout = null;
      }
      // If sidebar is expanded and not manually toggled, schedule auto-collapse
      if (sidebar && !sidebar.classList.contains("collapsed") && !sidebarManuallyToggled) {
        scheduleAutoCollapse();
      }
    });

    btn.addEventListener("click", () => {
      const view = btn.dataset.view;
      if (!view) return;

      // If sidebar is expanded and not manually toggled, schedule auto-collapse
      if (sidebar && !sidebar.classList.contains("collapsed") && !sidebarManuallyToggled) {
        scheduleAutoCollapse();
      }

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

function scheduleAutoCollapse(): void {
  if (autoCollapseTimeout) {
    clearTimeout(autoCollapseTimeout);
  }

  // Only auto-collapse if sidebar wasn't manually toggled
  if (sidebarManuallyToggled) {
    return;
  }

  const sidebar = document.getElementById("sidebar");
  if (!sidebar || sidebar.classList.contains("collapsed")) {
    return;
  }

  autoCollapseTimeout = window.setTimeout(() => {
    if (sidebar && !sidebarManuallyToggled) {
      sidebar.classList.add("collapsed");
      localStorage.setItem("sidebar-expanded", "false");
    }
    autoCollapseTimeout = null;
  }, AUTO_COLLAPSE_DELAY);
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
      const detailsEl = modal.querySelector(".progress-details") as HTMLElement;
      const userInfoEl = modal.querySelector("#progress-user-info") as HTMLElement;
      const serverInfoEl = modal.querySelector("#progress-server-info") as HTMLElement;
      const pingInfoEl = modal.querySelector("#progress-ping-info") as HTMLElement;
      const downloadInfoEl = modal.querySelector("#progress-download-info") as HTMLElement;
      const uploadInfoEl = modal.querySelector("#progress-upload-info") as HTMLElement;

      const result = await runSpeedtestWithProgress((stage: string, message: string) => {
        if (statusEl) statusEl.textContent = stage;
        if (messageEl) messageEl.textContent = message;
        btn.textContent = message;

        // Show details based on stage
        if (stage === "user" && message.includes("Connected from")) {
          const match = message.match(/Connected from (.+?) \((.+?)\)/);
          if (match) {
            userInfoEl.innerHTML = `<strong>IP:</strong> ${match[1]} | <strong>ISP:</strong> ${match[2]}`;
            userInfoEl.style.display = "block";
          }
        } else if (stage === "servers" && message.includes("Selected server")) {
          const match = message.match(/Selected server: (.+?)$/);
          if (match) {
            serverInfoEl.innerHTML = `<strong>Server:</strong> ${match[1]}`;
            serverInfoEl.style.display = "block";
          }
        } else if (stage === "ping" && message.includes("Ping:")) {
          const match = message.match(/Ping: (.+?) ms, Jitter: (.+?) ms/);
          if (match) {
            pingInfoEl.innerHTML = `<strong>Ping:</strong> ${match[1]} ms | <strong>Jitter:</strong> ${match[2]} ms`;
            pingInfoEl.style.display = "block";
          }
        } else if (stage === "download" && message.includes("Download:")) {
          const match = message.match(/Download: (.+?) Mbps/);
          if (match) {
            downloadInfoEl.innerHTML = `<strong>Download Speed:</strong> <span style="color: #4a9eff; font-weight: bold;">${match[1]} Mbps</span>`;
            downloadInfoEl.style.display = "block";
          }
        } else if (stage === "upload" && message.includes("Upload:")) {
          const match = message.match(/Upload: (.+?) Mbps/);
          if (match) {
            uploadInfoEl.innerHTML = `<strong>Upload Speed:</strong> <span style="color: #4a9eff; font-weight: bold;">${match[1]} Mbps</span>`;
            uploadInfoEl.style.display = "block";
          }
        }
      });

      // Close progress modal
      closeProgressModal(modal);

      // Show results modal
      const saved = await showResultsModal(result);

      // Refresh data if result was saved
      if (saved) {
        await Promise.all([
          loadSummary(),
          loadHistoryTable(),
          updateDownloadChart(),
          updateUploadChart(),
          updateLatencyChart(),
          updateJitterChart(),
        ]);
      }
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
    <div class="progress-modal" style="max-width: 500px;">
      <div class="progress-header">
        <h3>Running Speedtest</h3>
      </div>
      <div class="progress-content" style="padding: 20px;">
        <div class="progress-spinner" style="margin-bottom: 20px;"></div>
        <div class="progress-status" style="font-size: 14px; font-weight: bold; margin-bottom: 8px; text-transform: capitalize;"></div>
        <div class="progress-message" style="font-size: 13px; color: #aaa; margin-bottom: 16px;"></div>
        <div class="progress-details" style="border-top: 1px solid #333; padding-top: 16px; margin-top: 16px; font-size: 12px; color: #888;">
          <div id="progress-user-info" style="display: none; margin-bottom: 8px;"></div>
          <div id="progress-server-info" style="display: none; margin-bottom: 8px;"></div>
          <div id="progress-ping-info" style="display: none; margin-bottom: 8px;"></div>
          <div id="progress-download-info" style="display: none; margin-bottom: 8px;"></div>
          <div id="progress-upload-info" style="display: none; margin-bottom: 8px;"></div>
        </div>
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

function showResultsModal(result: SpeedtestResult): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = "progress-modal-overlay";

    const serverInfo = result.server_name
      ? `${result.server_name}${result.server_country ? ` (${result.server_country})` : ""}${result.server_id ? ` [${result.server_id}]` : ""}`
      : result.server_id || "–";

    modal.innerHTML = `
      <div class="progress-modal" style="max-width: 600px;">
        <div class="progress-header">
          <h3>Speedtest Results</h3>
        </div>
        <div class="progress-content" style="padding: 20px;">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px;">
            <div>
              <div style="font-size: 12px; color: #888; margin-bottom: 4px;">Download</div>
              <div style="font-size: 24px; font-weight: bold;">${formatNumber(result.download_mbps)} <span style="font-size: 14px; font-weight: normal;">Mbps</span></div>
            </div>
            <div>
              <div style="font-size: 12px; color: #888; margin-bottom: 4px;">Upload</div>
              <div style="font-size: 24px; font-weight: bold;">${formatNumber(result.upload_mbps)} <span style="font-size: 14px; font-weight: normal;">Mbps</span></div>
            </div>
            <div>
              <div style="font-size: 12px; color: #888; margin-bottom: 4px;">Ping</div>
              <div style="font-size: 20px; font-weight: bold;">${formatNumber(result.ping_ms, 1)} <span style="font-size: 14px; font-weight: normal;">ms</span></div>
            </div>
            <div>
              <div style="font-size: 12px; color: #888; margin-bottom: 4px;">Jitter</div>
              <div style="font-size: 20px; font-weight: bold;">${formatNumber(result.jitter_ms ?? 0, 1)} <span style="font-size: 14px; font-weight: normal;">ms</span></div>
            </div>
          </div>

          ${result.packet_loss_pct != null && result.packet_loss_pct >= 0 ? `
            <div style="margin-bottom: 16px;">
              <div style="font-size: 12px; color: #888; margin-bottom: 4px;">Packet Loss</div>
              <div style="font-size: 18px;">${formatNumber(result.packet_loss_pct, 2)}%</div>
            </div>
          ` : ""}

          <div style="border-top: 1px solid #333; padding-top: 16px; margin-top: 16px;">
            <div style="margin-bottom: 8px;">
              <span style="font-size: 12px; color: #888;">Timestamp:</span>
              <span style="margin-left: 8px;">${formatDateTime(new Date(result.timestamp))}</span>
            </div>
            ${result.isp ? `
              <div style="margin-bottom: 8px;">
                <span style="font-size: 12px; color: #888;">ISP:</span>
                <span style="margin-left: 8px;">${result.isp}</span>
              </div>
            ` : ""}
            ${result.external_ip ? `
              <div style="margin-bottom: 8px;">
                <span style="font-size: 12px; color: #888;">External IP:</span>
                <span style="margin-left: 8px; font-family: monospace;">${result.external_ip}</span>
              </div>
            ` : ""}
            <div style="margin-bottom: 8px;">
              <span style="font-size: 12px; color: #888;">Server:</span>
              <span style="margin-left: 8px;">${serverInfo}</span>
            </div>
            <div style="margin-bottom: 8px;">
              <span style="font-size: 12px; color: #888;">ID:</span>
              <span style="margin-left: 8px; font-family: monospace; font-size: 11px;">${result.id}</span>
            </div>
          </div>

          <div style="display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; padding-top: 16px; border-top: 1px solid #333;">
            <button id="results-modal-ok" style="padding: 8px 16px; cursor: pointer;">OK</button>
            <button id="results-modal-save" style="padding: 8px 16px; cursor: pointer; background: #4a9eff; color: white; border: none;">Save</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const handleClose = (saved: boolean) => {
      if (modal && modal.parentNode) {
        modal.parentNode.removeChild(modal);
      }
      resolve(saved);
    };

    // OK button
    const okBtn = modal.querySelector("#results-modal-ok") as HTMLButtonElement;
    okBtn.addEventListener("click", () => handleClose(false));

    // Save button
    const saveBtn = modal.querySelector("#results-modal-save") as HTMLButtonElement;
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";
      try {
        await fetchJSON("/api/results", {
          method: "POST",
          body: JSON.stringify(result),
        });
        handleClose(true);
      } catch (err) {
        console.error("Failed to save result:", err);
        alert("Failed to save result. Please try again.");
        saveBtn.disabled = false;
        saveBtn.textContent = "Save";
      }
    });

    // ESC key handler
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        document.removeEventListener("keydown", escHandler);
        handleClose(false);
      }
    };
    document.addEventListener("keydown", escHandler);

    // Click outside to close (optional, but let's not do this to avoid accidental closes)
  });
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

  // Load saved preferences
  const savedRangeDownload = localStorage.getItem("chart-range-download");
  const savedRangeUpload = localStorage.getItem("chart-range-upload");
  const savedRangeLatency = localStorage.getItem("chart-range-latency");
  const savedRangeJitter = localStorage.getItem("chart-range-jitter");

  const savedPercentileDownload = localStorage.getItem("chart-percentile-download") === "true";
  const savedPercentileUpload = localStorage.getItem("chart-percentile-upload") === "true";
  const savedPercentileLatency = localStorage.getItem("chart-percentile-latency") === "true";
  const savedPercentileJitter = localStorage.getItem("chart-percentile-jitter") === "true";

  if (savedRangeDownload) d.value = savedRangeDownload;
  if (savedRangeUpload) u.value = savedRangeUpload;
  if (savedRangeLatency) l.value = savedRangeLatency;
  if (savedRangeJitter) j.value = savedRangeJitter;

  if (savedPercentileDownload) dt?.classList.add("active");
  if (savedPercentileUpload) ut?.classList.add("active");
  if (savedPercentileLatency) lt?.classList.add("active");
  if (savedPercentileJitter) jt?.classList.add("active");

  d.addEventListener("change", () => {
    localStorage.setItem("chart-range-download", d.value);
    updateDownloadChart().catch((err) =>
      console.error("updateDownloadChart", err),
    );
  });
  u.addEventListener("change", () => {
    localStorage.setItem("chart-range-upload", u.value);
    updateUploadChart().catch((err) =>
      console.error("updateUploadChart", err),
    );
  });
  l.addEventListener("change", () => {
    localStorage.setItem("chart-range-latency", l.value);
    updateLatencyChart().catch((err) =>
      console.error("updateLatencyChart", err),
    );
  });
  j.addEventListener("change", () => {
    localStorage.setItem("chart-range-jitter", j.value);
    updateJitterChart().catch((err) =>
      console.error("updateJitterChart", err),
    );
  });

  dt?.addEventListener("click", () => {
    dt.classList.toggle("active");
    const isActive = dt.classList.contains("active");
    localStorage.setItem("chart-percentile-download", isActive ? "true" : "false");
    updateDownloadChart().catch((err) =>
      console.error("updateDownloadChart", err),
    );
  });
  ut?.addEventListener("click", () => {
    ut.classList.toggle("active");
    const isActive = ut.classList.contains("active");
    localStorage.setItem("chart-percentile-upload", isActive ? "true" : "false");
    updateUploadChart().catch((err) =>
      console.error("updateUploadChart", err),
    );
  });
  lt?.addEventListener("click", () => {
    lt.classList.toggle("active");
    const isActive = lt.classList.contains("active");
    localStorage.setItem("chart-percentile-latency", isActive ? "true" : "false");
    updateLatencyChart().catch((err) =>
      console.error("updateLatencyChart", err),
    );
  });
  jt?.addEventListener("click", () => {
    jt.classList.toggle("active");
    const isActive = jt.classList.contains("active");
    localStorage.setItem("chart-percentile-jitter", isActive ? "true" : "false");
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

function setupCombinedGraphPreference(): void {
  const checkbox = $("pref-combined-graph") as HTMLInputElement;
  const logCheckbox = $("pref-logarithmic-scale") as HTMLInputElement;
  const combinedPanel = $("combined-chart-panel");
  const individualCharts = $("individual-charts");
  const combinedRangeSelect = $("range-combined") as HTMLSelectElement;

  // Load preferences (default: false/off)
  const savedCombined = localStorage.getItem("combined-graph");
  const savedLog = localStorage.getItem("logarithmic-scale");
  const isCombinedEnabled = savedCombined === "true";
  const isLogEnabled = savedLog === "true";

  checkbox.checked = isCombinedEnabled;
  logCheckbox.checked = isLogEnabled;
  updateChartVisibility(isCombinedEnabled);

  const reloadCharts = () => {
    if (checkbox.checked) {
      updateCombinedChart().catch((err) =>
        console.error("updateCombinedChart", err),
      );
    } else {
      // Reload individual charts
      Promise.all([
        updateDownloadChart(),
        updateUploadChart(),
        updateLatencyChart(),
        updateJitterChart(),
      ]).catch((err) => console.error("updateCharts", err));
    }
  };

  checkbox.addEventListener("change", () => {
    const enabled = checkbox.checked;
    localStorage.setItem("combined-graph", enabled ? "true" : "false");
    updateChartVisibility(enabled);
    reloadCharts();
  });

  logCheckbox.addEventListener("change", () => {
    const enabled = logCheckbox.checked;
    localStorage.setItem("logarithmic-scale", enabled ? "true" : "false");
    // Only reload if combined graph is enabled
    if (checkbox.checked) {
      reloadCharts();
    }
  });

  // Load saved combined chart range
  const savedCombinedRange = localStorage.getItem("chart-range-combined");
  if (savedCombinedRange) {
    combinedRangeSelect.value = savedCombinedRange;
  }

  combinedRangeSelect.addEventListener("change", () => {
    localStorage.setItem("chart-range-combined", combinedRangeSelect.value);
    if (checkbox.checked) {
      reloadCharts();
    }
  });

  function updateChartVisibility(showCombined: boolean): void {
    if (showCombined) {
      combinedPanel.style.display = "block";
      individualCharts.style.display = "none";
    } else {
      combinedPanel.style.display = "none";
      individualCharts.style.display = "block";
    }
  }
}

function setupSaveManualRunsPreference(): void {
  const checkbox = $("pref-save-manual-runs") as HTMLInputElement;

  // Load preference from server
  fetchJSON<{ save_manual_runs: boolean }>("/api/preferences")
    .then((data) => {
      checkbox.checked = data.save_manual_runs;
    })
    .catch((err) => {
      console.error("Failed to load save manual runs preference:", err);
      checkbox.checked = false; // Default to false
    });

  // Save preference when changed
  checkbox.addEventListener("change", async () => {
    try {
      await fetchJSON("/api/preferences", {
        method: "PUT",
        body: JSON.stringify({
          save_manual_runs: checkbox.checked,
        }),
      });
    } catch (err) {
      console.error("Failed to save save manual runs preference:", err);
      alert("Failed to save preference. Please try again.");
      // Revert checkbox state
      checkbox.checked = !checkbox.checked;
    }
  });
}

/* ---------- SCHEDULE TIMER ---------- */

let scheduleTimerInterval: number | null = null;
let nextRunTime: number | null = null;
let intervalDuration: number | null = null; // Full interval duration in milliseconds
let intervalStartTime: number | null = null; // When the current interval started
let ws: WebSocket | null = null;

async function updateScheduleTimer(): Promise<void> {
  try {
    const data = await fetchJSON<{
      next_run: string | null;
      remaining: number;
      interval_duration: number;
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
      nextRunTime = null;
      intervalDuration = null;
      intervalStartTime = null;
      return;
    }

    timerEl.style.display = "block";
    const nextRun = new Date(data.next_run).getTime();
    nextRunTime = nextRun;
    intervalDuration = (data.interval_duration || 0) * 1000; // Convert to milliseconds
    // Calculate when the current interval started: nextRun - intervalDuration
    intervalStartTime = nextRun - intervalDuration;
    updateTimerDisplay();
  } catch (err) {
    console.error("Failed to fetch next run time:", err);
  }
}

function updateTimerDisplay(): void {
  const timerEl = document.getElementById("schedule-timer");
  if (!timerEl || !nextRunTime || !intervalDuration || !intervalStartTime) return;

  const now = Date.now();
  const remaining = Math.max(0, nextRunTime - now);
  // Calculate elapsed time since interval started
  const elapsed = now - intervalStartTime;
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

function connectWebSocket(): void {
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
          // New speedtest completed, refresh all data
          const isCombinedGraph = localStorage.getItem("combined-graph") === "true";
          const chartPromises = isCombinedGraph
            ? [updateCombinedChart()]
            : [
                updateDownloadChart(),
                updateUploadChart(),
                updateLatencyChart(),
                updateJitterChart(),
              ];
          Promise.all([
            loadSummary(),
            loadHistoryTable(),
            ...chartPromises,
          ]).catch((err) => console.error("refresh after speedtest failed", err));
        } else if (data.type === "ping") {
          // Keep-alive ping, no action needed
        } else if (data.type === "status") {
          // Connection status, no action needed
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
      // Reconnect after 2 seconds
      setTimeout(connectWebSocket, 2000);
    };
  } catch (err) {
    console.error("Failed to create WebSocket:", err);
    // Retry after 2 seconds
    setTimeout(connectWebSocket, 2000);
  }
}

/* ---------- INIT ---------- */

async function init(): Promise<void> {
  setupNav();
  setupRunNow();
  setupScheduleForm();
  setupRangeSelectors();
  setupHistoryPagination();
  setupThemeSelection();
  setupCombinedGraphPreference();
  setupSaveManualRunsPreference();
  startScheduleTimer();
  connectWebSocket();

  const isCombinedGraph = localStorage.getItem("combined-graph") === "true";
  const chartPromises = isCombinedGraph
    ? [updateCombinedChart()]
    : [
        updateDownloadChart(),
        updateUploadChart(),
        updateLatencyChart(),
        updateJitterChart(),
      ];

  await Promise.all([
    loadSummary(),
    loadHistoryTable(),
    loadSchedules(),
    ...chartPromises,
  ]);
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => console.error(err));
});

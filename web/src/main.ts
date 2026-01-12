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

async function loadHistoryTable(): Promise<void> {
  const url = "/api/history?range=24h";

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

type RangeKey = "24h" | "7d" | "30d";


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
  // Use fixed viewBox coordinate system - SVG will scale to container
  // This ensures labels and elements are positioned correctly
  const width = 300;
  const height = 50;
  const paddingX = 12;
  const paddingY = 8;
  const paddingBottom = 12; // Space for x-axis labels

  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.style.width = "100%";
  svg.style.height = "100%";

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

  // Create tooltip element (before drawing elements that need it)
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

  // Helper to get metric name and unit
  const getMetricInfo = (k: string): { name: string; unit: string } => {
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

  // Calculate and draw average line
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

    // Add hover event for average line tooltip
    avgLine.addEventListener("mouseenter", (e) => {
      const svgRect = svg.getBoundingClientRect();
      const scaleY = svgRect.height / height;
      const mouseX = (e as MouseEvent).clientX;
      const y = svgRect.top + avgY * scaleY;

      tooltip.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 2px;">Average ${metricInfo.name}</div>
        <div>${formatNumber(avgValue, 2)} ${metricInfo.unit}</div>
        <div style="color: var(--muted, #B0B0B0); font-size: 10px; margin-top: 2px;">Based on ${rows.length} measurement${rows.length !== 1 ? "s" : ""}</div>
      `;
      tooltip.style.display = "block";

      // Position tooltip above the cursor, centered horizontally
      const tooltipRect = tooltip.getBoundingClientRect();
      tooltip.style.left = `${mouseX - tooltipRect.width / 2}px`;
      tooltip.style.top = `${y - tooltipRect.height - 8}px`;
    });

    avgLine.addEventListener("mouseleave", () => {
      tooltip.style.display = "none";
    });

    svg.appendChild(avgLine);
  }

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


  // Draw data points with tooltips
  coords.forEach((coord, index) => {
    const circle = document.createElementNS(svgNS, "circle");
    circle.setAttribute("cx", coord.x.toString());
    circle.setAttribute("cy", coord.y.toString());
    circle.setAttribute("r", "1.2");
    circle.setAttribute("fill", "#ffb341");
    circle.style.cursor = "pointer";

    // Add hover events for tooltip
    const row = rows[index];
    const value = values[index];
    const date = new Date(row.timestamp);

    circle.addEventListener("mouseenter", (e) => {
      const svgRect = svg.getBoundingClientRect();
      const scaleX = svgRect.width / width;
      const scaleY = svgRect.height / height;

      // Highlight the circle
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

      // Position tooltip above the point, centered horizontally
      // Get dimensions after display
      const tooltipRect = tooltip.getBoundingClientRect();
      tooltip.style.left = `${x - tooltipRect.width / 2}px`;
      tooltip.style.top = `${y - tooltipRect.height - 8}px`;
    });

    circle.addEventListener("mouseleave", () => {
      // Restore original circle size
      circle.setAttribute("r", "1.2");
      circle.setAttribute("fill", "#ffb341");
      circle.removeAttribute("stroke");
      circle.removeAttribute("stroke-width");
      tooltip.style.display = "none";
    });

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


async function renderPercentileChart(
  containerId: string,
  range: RangeKey,
  metric: "download" | "upload" | "ping" | "jitter",
): Promise<void> {
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
  // Use fixed viewBox coordinate system - SVG will scale to container
  // This ensures labels and elements are positioned correctly
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
  const whiskerCapWidth = 6;

  // Draw box (Q1 to Q3) - filled orange, drawn first so whiskers appear on top
  const boxY1 = yPos(stats.q3); // Top of box (Q3 is higher value, lower Y position)
  const boxY2 = yPos(stats.q1); // Bottom of box (Q1 is lower value, higher Y position)
  const box = document.createElementNS(svgNS, "rect");
  box.setAttribute("x", (centerX - boxWidth / 2).toString());
  box.setAttribute("y", boxY1.toString());
  box.setAttribute("width", boxWidth.toString());
  box.setAttribute("height", (boxY2 - boxY1).toString());
  box.setAttribute("fill", "#ffb341"); // Solid orange fill
  box.setAttribute("stroke", "rgba(255,179,65,0.8)");
  box.setAttribute("stroke-width", "0.3");
  svg.appendChild(box);

  // Draw median line (darker orange inside the box)
  const medianY = yPos(stats.median);
  const medianLine = document.createElementNS(svgNS, "line");
  medianLine.setAttribute("x1", (centerX - boxWidth / 2).toString());
  medianLine.setAttribute("x2", (centerX + boxWidth / 2).toString());
  medianLine.setAttribute("y1", medianY.toString());
  medianLine.setAttribute("y2", medianY.toString());
  medianLine.setAttribute("stroke", "#ff8c00"); // Darker orange for median
  medianLine.setAttribute("stroke-width", "1.2");
  svg.appendChild(medianLine);

  // Draw whiskers (vertical lines with horizontal caps)
  // Upper whisker: from Q3 to max
  const upperWhiskerY = yPos(stats.max);
  const upperWhisker = document.createElementNS(svgNS, "line");
  upperWhisker.setAttribute("x1", centerX.toString());
  upperWhisker.setAttribute("x2", centerX.toString());
  upperWhisker.setAttribute("y1", boxY1.toString()); // Start at top of box (Q3)
  upperWhisker.setAttribute("y2", upperWhiskerY.toString()); // End at max
  upperWhisker.setAttribute("stroke", "rgba(255,255,255,0.4)");
  upperWhisker.setAttribute("stroke-width", "0.4");
  svg.appendChild(upperWhisker);

  // Upper whisker cap (horizontal line at max)
  const upperCap = document.createElementNS(svgNS, "line");
  upperCap.setAttribute("x1", (centerX - whiskerCapWidth / 2).toString());
  upperCap.setAttribute("x2", (centerX + whiskerCapWidth / 2).toString());
  upperCap.setAttribute("y1", upperWhiskerY.toString());
  upperCap.setAttribute("y2", upperWhiskerY.toString());
  upperCap.setAttribute("stroke", "rgba(255,255,255,0.4)");
  upperCap.setAttribute("stroke-width", "0.4");
  svg.appendChild(upperCap);

  // Lower whisker: from Q1 to min
  const lowerWhiskerY = yPos(stats.min);
  const lowerWhisker = document.createElementNS(svgNS, "line");
  lowerWhisker.setAttribute("x1", centerX.toString());
  lowerWhisker.setAttribute("x2", centerX.toString());
  lowerWhisker.setAttribute("y1", boxY2.toString()); // Start at bottom of box (Q1)
  lowerWhisker.setAttribute("y2", lowerWhiskerY.toString()); // End at min
  lowerWhisker.setAttribute("stroke", "rgba(255,255,255,0.4)");
  lowerWhisker.setAttribute("stroke-width", "0.4");
  svg.appendChild(lowerWhisker);

  // Lower whisker cap (horizontal line at min)
  const lowerCap = document.createElementNS(svgNS, "line");
  lowerCap.setAttribute("x1", (centerX - whiskerCapWidth / 2).toString());
  lowerCap.setAttribute("x2", (centerX + whiskerCapWidth / 2).toString());
  lowerCap.setAttribute("y1", lowerWhiskerY.toString());
  lowerCap.setAttribute("y2", lowerWhiskerY.toString());
  lowerCap.setAttribute("stroke", "rgba(255,255,255,0.4)");
  lowerCap.setAttribute("stroke-width", "0.4");
  svg.appendChild(lowerCap);

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
  if (toggle?.classList.contains("active")) {
    await renderPercentileChart("download-chart", value, "download");
  } else {
    const rows = await loadHistoryForRange(value);
    renderLineChart("download-chart", rows, "download_mbps");
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
    renderLineChart("upload-chart", rows, "upload_mbps");
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
    renderLineChart("latency-chart", rows, "ping_ms");
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
    renderLineChart("jitter-chart", rows, "jitter_ms");
  }
}

function renderCombinedChart(
  containerId: string,
  rows: SpeedtestResult[],
): void {
  const container = $(containerId);
  container.innerHTML = "";

  if (!rows.length) {
    container.textContent = "No data for selected range.";
    return;
  }

  const svgNS = "http://www.w3.org/2000/svg";
  const width = 300;
  const height = 50;
  const paddingLeft = 28; // Space for Y-axis labels
  const paddingRight = 12;
  const paddingTop = 8;
  const paddingBottom = 20; // Space for X-axis labels and legend
  const paddingX = paddingLeft;
  const paddingY = paddingTop;

  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.style.width = "100%";
  svg.style.height = "100%";

  const times = rows.map((r) => new Date(r.timestamp).getTime());
  const downloadValues = rows.map((r) => r.download_mbps);
  const uploadValues = rows.map((r) => r.upload_mbps);
  const pingValues = rows.map((r) => r.ping_ms);
  const jitterValues = rows.map((r) => r.jitter_ms ?? 0);

  const minX = Math.min(...times);
  const maxX = Math.max(...times);

  // Colors for each metric
  const metrics = [
    { key: "download_mbps", values: downloadValues, color: "#4ade80", name: "Download", unit: "Mbps" },
    { key: "upload_mbps", values: uploadValues, color: "#60a5fa", name: "Upload", unit: "Mbps" },
    { key: "ping_ms", values: pingValues, color: "#fbbf24", name: "Ping", unit: "ms" },
    { key: "jitter_ms", values: jitterValues, color: "#f87171", name: "Jitter", unit: "ms" },
  ];

  // Check if logarithmic scale is enabled
  const useLogarithmic = localStorage.getItem("logarithmic-scale") === "true";

  // Calculate min/max for each metric separately
  const metricRanges = metrics.map((metric) => {
    const vals = metric.values.filter((v) => Number.isFinite(v));
    if (vals.length === 0) {
      if (useLogarithmic) {
        return { min: 1, max: 10, logMin: 0, logMax: 1, logRange: 1, range: 1 };
      }
      return { min: 0, max: 1, range: 1 };
    }
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = max - min || 1; // Avoid division by zero

    if (useLogarithmic) {
      // Use a small epsilon to avoid log(0) or log(negative)
      const safeMin = Math.max(min, 0.001);
      const logMin = Math.log10(safeMin);
      const logMax = Math.log10(max);
      const logRange = logMax - logMin || 1;
      return { min: safeMin, max, logMin, logMax, logRange, range };
    }

    return { min, max, range };
  });

  const innerW = width - paddingLeft - paddingRight;
  const innerH = height - paddingTop - paddingBottom;

  // Create tooltip
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

  // Draw grid lines (horizontal)
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = paddingY + (innerH / gridLines) * i;
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", paddingLeft.toString());
    line.setAttribute("x2", (width - paddingRight).toString());
    line.setAttribute("y1", y.toString());
    line.setAttribute("y2", y.toString());
    line.setAttribute("stroke", "rgba(255,255,255,0.1)");
    line.setAttribute("stroke-width", "0.3");
    svg.appendChild(line);
  }

  // Draw grid lines (vertical) - show first, middle, last
  const verticalGridPositions = [0, Math.floor(times.length / 2), times.length - 1];
  verticalGridPositions.forEach((idx) => {
    if (idx < 0 || idx >= times.length) return;
    const xNorm = (times[idx] - minX) / (maxX - minX);
    const x = paddingLeft + xNorm * innerW;
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", x.toString());
    line.setAttribute("x2", x.toString());
    line.setAttribute("y1", paddingY.toString());
    line.setAttribute("y2", (height - paddingBottom).toString());
    line.setAttribute("stroke", "rgba(255,255,255,0.1)");
    line.setAttribute("stroke-width", "0.3");
    svg.appendChild(line);
  });

  // Draw Y-axis labels
  if (useLogarithmic) {
    // Logarithmic scale - show combined range
    const overallMin = Math.min(...metricRanges.map((r) => r.min));
    const overallMax = Math.max(...metricRanges.map((r) => r.max));
    const overallLogMin = Math.log10(Math.max(overallMin, 0.001));
    const overallLogMax = Math.log10(overallMax);
    const overallLogRange = overallLogMax - overallLogMin;

    for (let i = 0; i <= gridLines; i++) {
      const y = paddingY + (innerH / gridLines) * i;
      // Calculate log position (inverted: top is max, bottom is min)
      const logPos = overallLogMax - (i / gridLines) * overallLogRange;
      const value = Math.pow(10, logPos);

      // Format value appropriately
      let label: string;
      if (value >= 1000) {
        label = `${(value / 1000).toFixed(1)}k`;
      } else if (value >= 1) {
        label = value.toFixed(1);
      } else {
        label = value.toFixed(3);
      }

      const text = document.createElementNS(svgNS, "text");
      text.setAttribute("x", (paddingLeft - 4).toString());
      text.setAttribute("y", (y + 1.5).toString());
      text.setAttribute("text-anchor", "end");
      text.setAttribute("fill", "rgba(255,255,255,0.5)");
      text.setAttribute("font-size", "2.2");
      text.textContent = label;
      svg.appendChild(text);
    }
  } else {
    // Percentage scale (0-100%)
    for (let i = 0; i <= gridLines; i++) {
      const y = paddingY + (innerH / gridLines) * i;
      const percent = 100 - (i / gridLines) * 100;
      const text = document.createElementNS(svgNS, "text");
      text.setAttribute("x", (paddingLeft - 4).toString());
      text.setAttribute("y", (y + 1.5).toString());
      text.setAttribute("text-anchor", "end");
      text.setAttribute("fill", "rgba(255,255,255,0.5)");
      text.setAttribute("font-size", "2.2");
      text.textContent = `${Math.round(percent)}%`;
      svg.appendChild(text);
    }
  }

  // Draw X-axis labels (time)
  const xLabelPositions = [0, Math.floor(times.length / 2), times.length - 1];
  xLabelPositions.forEach((idx) => {
    if (idx < 0 || idx >= times.length) return;
    const xNorm = (times[idx] - minX) / (maxX - minX);
    const x = paddingLeft + xNorm * innerW;
    const date = new Date(times[idx]);
    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", x.toString());
    text.setAttribute("y", (height - paddingBottom + 6).toString());
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "rgba(255,255,255,0.5)");
    text.setAttribute("font-size", "2.2");
    text.textContent = formatTime24h(date);
    svg.appendChild(text);
  });

  // Calculate overall range for positioning (used in both modes)
  let overallMin: number, overallMax: number, overallRange: number;
  let overallLogMin: number, overallLogMax: number, overallLogRange: number;

  if (useLogarithmic) {
    overallMin = Math.min(...metricRanges.map((r) => r.min));
    overallMax = Math.max(...metricRanges.map((r) => r.max));
    overallLogMin = Math.log10(Math.max(overallMin, 0.001));
    overallLogMax = Math.log10(overallMax);
    overallLogRange = overallLogMax - overallLogMin;
  } else {
    // For percentage mode, normalize each metric separately
    overallMin = 0;
    overallMax = 1;
    overallRange = 1;
  }

  // Draw lines, averages, and data points for each metric
  metrics.forEach((metric, metricIdx) => {
    const range = metricRanges[metricIdx];
    const coords: { x: number; y: number }[] = [];

    for (let i = 0; i < times.length; i++) {
      const xNorm = (times[i] - minX) / (maxX - minX);
      const x = paddingLeft + xNorm * innerW;

      let yNorm: number;
      if (useLogarithmic) {
        // Use logarithmic normalization
        const safeValue = Math.max(metric.values[i], 0.001);
        const overallLogValue = Math.log10(safeValue);
        yNorm = overallLogRange > 0
          ? (overallLogValue - overallLogMin) / overallLogRange
          : 0.5;
      } else {
        // Use linear normalization (percentage) - each metric normalized separately
        yNorm = range.range > 0 ? (metric.values[i] - range.min) / range.range : 0.5;
      }

      const y = paddingY + innerH - yNorm * innerH;
      coords.push({ x, y });
    }

    // Calculate and draw average line
    const avgValue = metric.values.reduce((sum, val) => sum + val, 0) / metric.values.length;
    if (Number.isFinite(avgValue)) {
      let avgYNorm: number;
      if (useLogarithmic) {
        if (avgValue > 0) {
          const safeAvg = Math.max(avgValue, 0.001);
          const logAvg = Math.log10(safeAvg);
          avgYNorm = overallLogRange > 0
            ? (logAvg - overallLogMin) / overallLogRange
            : 0.5;
        } else {
          return; // Skip average line if value is <= 0 in log mode
        }
      } else {
        avgYNorm = range.range > 0 ? (avgValue - range.min) / range.range : 0.5;
        if (avgYNorm < 0 || avgYNorm > 1) return; // Skip if outside range
      }

      const avgY = paddingY + innerH - avgYNorm * innerH;

      const avgLine = document.createElementNS(svgNS, "line");
      avgLine.setAttribute("x1", paddingLeft.toString());
      avgLine.setAttribute("x2", (width - paddingRight).toString());
      avgLine.setAttribute("y1", avgY.toString());
      avgLine.setAttribute("y2", avgY.toString());
      avgLine.setAttribute("stroke", metric.color);
      avgLine.setAttribute("stroke-width", "0.6");
      avgLine.setAttribute("stroke-dasharray", "2,2");
      avgLine.setAttribute("opacity", "0.6");
      avgLine.style.cursor = "pointer";

      // Add hover event for average line tooltip
      avgLine.addEventListener("mouseenter", (e) => {
        const svgRect = svg.getBoundingClientRect();
        const scaleY = svgRect.height / height;
        const mouseX = (e as MouseEvent).clientX;
        const y = svgRect.top + avgY * scaleY;

        tooltip.innerHTML = `
          <div style="font-weight: 600; margin-bottom: 2px;">Average ${metric.name}</div>
          <div>${formatNumber(avgValue, 2)} ${metric.unit}</div>
          <div style="color: var(--muted, #B0B0B0); font-size: 10px; margin-top: 2px;">Based on ${rows.length} measurement${rows.length !== 1 ? "s" : ""}</div>
        `;
        tooltip.style.display = "block";
        const tooltipRect = tooltip.getBoundingClientRect();
        tooltip.style.left = `${mouseX - tooltipRect.width / 2}px`;
        tooltip.style.top = `${y - tooltipRect.height - 5}px`;
      });

      avgLine.addEventListener("mouseleave", () => {
        tooltip.style.display = "none";
      });

      svg.appendChild(avgLine);
    }

    // Draw line
    if (coords.length > 1) {
      const path = document.createElementNS(svgNS, "path");
      let pathData = `M ${coords[0].x} ${coords[0].y}`;
      for (let i = 1; i < coords.length; i++) {
        pathData += ` L ${coords[i].x} ${coords[i].y}`;
      }
      path.setAttribute("d", pathData);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", metric.color);
      path.setAttribute("stroke-width", "0.8");
      path.setAttribute("opacity", "0.8");
      svg.appendChild(path);
    }

    // Draw data points
    coords.forEach((coord, index) => {
      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("cx", coord.x.toString());
      circle.setAttribute("cy", coord.y.toString());
      circle.setAttribute("r", "1.2");
      circle.setAttribute("fill", metric.color);
      circle.style.cursor = "pointer";

      const row = rows[index];
      const value = metric.values[index];
      const date = new Date(row.timestamp);

      circle.addEventListener("mouseenter", (e) => {
        const svgRect = svg.getBoundingClientRect();
        const scaleX = svgRect.width / width;
        const scaleY = svgRect.height / height;

        circle.setAttribute("r", "1.4");
        circle.setAttribute("stroke", "#ffd700");
        circle.setAttribute("stroke-width", "0.5");

        tooltip.innerHTML = `
          <div style="font-weight: 600; margin-bottom: 2px;">${metric.name}</div>
          <div>${formatNumber(value, 2)} ${metric.unit}</div>
          <div style="color: var(--muted, #B0B0B0); font-size: 10px; margin-top: 2px;">${formatDateTime(date)}</div>
        `;
        tooltip.style.display = "block";

        const x = svgRect.left + coord.x * scaleX;
        const y = svgRect.top + coord.y * scaleY;
        const tooltipRect = tooltip.getBoundingClientRect();
        tooltip.style.left = `${x - tooltipRect.width / 2}px`;
        tooltip.style.top = `${y - tooltipRect.height - 5}px`;
      });

      circle.addEventListener("mouseleave", () => {
        circle.setAttribute("r", "1.2");
        circle.removeAttribute("stroke");
        circle.removeAttribute("stroke-width");
        tooltip.style.display = "none";
      });

      svg.appendChild(circle);
    });
  });

  // Add legend
  const legendY = height - paddingBottom + 4;
  let legendX = paddingLeft;
  metrics.forEach((metric) => {
    const legendGroup = document.createElementNS(svgNS, "g");

    const circle = document.createElementNS(svgNS, "circle");
    circle.setAttribute("cx", legendX.toString());
    circle.setAttribute("cy", legendY.toString());
    circle.setAttribute("r", "1.5");
    circle.setAttribute("fill", metric.color);
    legendGroup.appendChild(circle);

    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", (legendX + 4).toString());
    text.setAttribute("y", (legendY + 1).toString());
    text.setAttribute("fill", "rgba(255,255,255,0.7)");
    text.setAttribute("font-size", "2.5");
    text.textContent = metric.name;
    legendGroup.appendChild(text);

    svg.appendChild(legendGroup);
    legendX += metric.name.length * 3.5 + 8;
  });

  container.appendChild(svg);
}

async function updateCombinedChart(): Promise<void> {
  const select = $("range-combined") as HTMLSelectElement;
  const value = (select.value || "24h") as RangeKey;
  // Save the range preference
  localStorage.setItem("chart-range-combined", value);
  const rows = await loadHistoryForRange(value);
  renderCombinedChart("combined-chart", rows);
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
  setupThemeSelection();
  setupCombinedGraphPreference();
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

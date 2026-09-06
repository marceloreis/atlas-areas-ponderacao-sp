(() => {
  "use strict";

  const palette = ["#CAD2C5", "#84A98C", "#52796F", "#354F52", "#2F3E46"];
  const nullColor = "#dfe5eb";
  const baseStroke = "#000000";
  const selectedStroke = "#10243a";
  const absoluteValueGroups = new Set(["Tab2_1", "Tab2_3", "Tab8_1", "Tab8_2", "Tab8_3"]);
  const ptInteger = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
  const ptDecimal = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
  const ptPercent = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const ptArea = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

  const elements = {
    loadingState: document.querySelector("#loadingState"),
    areaCount: document.querySelector("#areaCount"),
    variableCount: document.querySelector("#variableCount"),
    areaSearch: document.querySelector("#areaSearch"),
    clearAreaSearch: document.querySelector("#clearAreaSearch"),
    areaResults: document.querySelector("#areaResults"),
    variableSearch: document.querySelector("#variableSearch"),
    clearVariableSearch: document.querySelector("#clearVariableSearch"),
    variableResults: document.querySelector("#variableResults"),
    groupSelect: document.querySelector("#groupSelect"),
    metricSelect: document.querySelector("#metricSelect"),
    metricSummary: document.querySelector("#metricSummary"),
    validCount: document.querySelector("#validCount"),
    legendItems: document.querySelector("#legendItems"),
    mapBadge: document.querySelector("#mapBadge"),
    mapBadgeText: document.querySelector("#mapBadgeText"),
    resetView: document.querySelector("#resetView"),
    detailsPanel: document.querySelector("#detailsPanel"),
    emptyDetails: document.querySelector("#emptyDetails"),
    detailsContent: document.querySelector("#detailsContent"),
    detailsClose: document.querySelector("#detailsClose"),
    detailName: document.querySelector("#detailName"),
    detailMunicipality: document.querySelector("#detailMunicipality"),
    detailCode: document.querySelector("#detailCode"),
    detailArea: document.querySelector("#detailArea"),
    detailSectors: document.querySelector("#detailSectors"),
    selectedMetricLabel: document.querySelector("#selectedMetricLabel"),
    selectedMetricValue: document.querySelector("#selectedMetricValue"),
    selectedMetricTable: document.querySelector("#selectedMetricTable"),
    detailSearch: document.querySelector("#detailSearch"),
    indicatorGroups: document.querySelector("#indicatorGroups"),
    controlPanel: document.querySelector("#controlPanel"),
    filtersToggle: document.querySelector("#filtersToggle"),
    filtersClose: document.querySelector("#filtersClose"),
    aboutButton: document.querySelector("#aboutButton"),
    aboutDialog: document.querySelector("#aboutDialog"),
    downloadGeoJson: document.querySelector("#downloadGeoJson"),
    toast: document.querySelector("#toast"),
  };

  const state = {
    map: null,
    geoLayer: null,
    stateBounds: null,
    geojson: null,
    census: null,
    featuresByCode: new Map(),
    layersByCode: new Map(),
    groupsById: new Map(),
    selectedCode: null,
    currentFieldIndex: 0,
    thresholds: [],
    numericValues: [],
    toastTimer: null,
  };

  function normalize(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("pt-BR")
      .replace(/\s+/g, " ")
      .trim();
  }

  function compactTableTitle(title) {
    return title.replace(/^Tabela\s+[\d._]+\s*[-–]\s*/i, "").trim();
  }

  function truncate(value, length) {
    const text = String(value ?? "");
    return text.length > length ? `${text.slice(0, length - 1).trim()}…` : text;
  }

  function numericValue(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const text = value.trim().replace(",", ".");
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatRawValue(value, field) {
    if (value === null || value === undefined || value === "" || value === "-") return "Sem dado";
    if (field.format === "integer") {
      const number = numericValue(value);
      return number === null ? String(value) : ptInteger.format(number);
    }
    if (field.format === "decimal") {
      const number = numericValue(value);
      return number === null ? String(value) : ptDecimal.format(number);
    }
    const number = numericValue(value);
    if (number !== null) return Number.isInteger(number) ? ptInteger.format(number) : ptDecimal.format(number);
    return String(value);
  }

  function isTotalField(field) {
    const group = state.groupsById.get(field.group);
    const totalFieldIndex = Number.isInteger(group?.total_field_index)
      ? group.total_field_index
      : group?.field_indexes?.[0];
    return field.is_total === true || totalFieldIndex === field.index;
  }

  function isAbsoluteField(field) {
    if (field.display_mode) return field.display_mode === "absolute";
    return isTotalField(field) || absoluteValueGroups.has(field.group);
  }

  function fieldDisplayLabel(field) {
    return isAbsoluteField(field) ? field.label : `${field.label} (% do Total)`;
  }

  function formatDisplayValue(value, field) {
    if (value === null || value === undefined || value === "" || value === "-") return "Sem dado";
    if (isAbsoluteField(field)) return formatRawValue(value, field);
    const number = numericValue(value);
    return number === null ? "Sem dado" : `${ptPercent.format(number)}%`;
  }

  function formatLegendValue(value) {
    const formatted = ptDecimal.format(value);
    return isAbsoluteField(currentField()) ? formatted : `${formatted}%`;
  }

  function currentField() {
    return state.census.fields[state.currentFieldIndex];
  }

  function currentGroup() {
    return state.groupsById.get(currentField().group);
  }

  function valueFromRow(row, fieldIndex = state.currentFieldIndex) {
    if (!row) return null;
    const field = state.census.fields[fieldIndex];
    const rawValue = row[fieldIndex];
    if (isAbsoluteField(field)) return rawValue;
    const group = state.groupsById.get(field.group);
    const totalFieldIndex = Number.isInteger(group?.total_field_index)
      ? group.total_field_index
      : group?.field_indexes?.[0];
    const numerator = numericValue(rawValue);
    const denominator = numericValue(row[totalFieldIndex]);
    if (numerator === null || denominator === null || denominator === 0) return null;
    return (numerator / denominator) * 100;
  }

  function valueForFeature(feature, fieldIndex = state.currentFieldIndex) {
    const row = state.census.rows[feature.properties.data_index];
    return valueFromRow(row, fieldIndex);
  }

  function computeTheme() {
    const values = state.geojson.features
      .map((feature) => numericValue(valueForFeature(feature)))
      .filter((value) => value !== null)
      .sort((a, b) => a - b);
    state.numericValues = values;
    state.thresholds = values.length
      ? [0.2, 0.4, 0.6, 0.8].map((proportion) => values[Math.round((values.length - 1) * proportion)])
      : [];
  }

  function colorForValue(value) {
    const number = numericValue(value);
    if (number === null || !state.thresholds.length) return nullColor;
    for (let index = 0; index < state.thresholds.length; index += 1) {
      if (number <= state.thresholds[index]) return palette[index];
    }
    return palette[palette.length - 1];
  }

  function styleFeature(feature) {
    const selected = feature.properties.cd_apond === state.selectedCode;
    return {
      color: selected ? selectedStroke : baseStroke,
      weight: selected ? 2.5 : 0.65,
      opacity: selected ? 1 : 0.78,
      fillColor: colorForValue(valueForFeature(feature)),
      fillOpacity: selected ? 0.9 : 0.74,
    };
  }

  function tooltipContent(feature) {
    const container = document.createElement("div");
    const name = document.createElement("strong");
    const place = document.createElement("span");
    const value = document.createElement("span");
    name.className = "tooltip-name";
    place.className = "tooltip-place";
    value.className = "tooltip-value";
    name.textContent = feature.properties.nm_apond || `Área ${feature.properties.cd_apond}`;
    place.textContent = feature.properties.NM_MUN;
    value.textContent = `${truncate(fieldDisplayLabel(currentField()), 54)}: ${formatDisplayValue(valueForFeature(feature), currentField())}`;
    container.append(name, place, value);
    return container;
  }

  function updateLegend() {
    elements.legendItems.replaceChildren();
    const values = state.numericValues;
    elements.validCount.textContent = values.length ? `${ptInteger.format(values.length)} áreas` : "Sem valores numéricos";
    if (!values.length) {
      const empty = document.createElement("div");
      empty.className = "empty-result";
      empty.textContent = "Esta variável não permite classificação numérica.";
      elements.legendItems.append(empty);
      return;
    }

    const limits = [values[0], ...state.thresholds, values[values.length - 1]];
    palette.forEach((color, index) => {
      const row = document.createElement("div");
      const swatch = document.createElement("span");
      const label = document.createElement("span");
      row.className = "legend-row";
      swatch.style.background = color;
      const low = limits[index];
      const high = limits[index + 1];
      if (index === 0) label.textContent = `Até ${formatLegendValue(high)}`;
      else if (index === palette.length - 1) label.textContent = `Mais de ${formatLegendValue(low)}`;
      else label.textContent = `${formatLegendValue(low)} – ${formatLegendValue(high)}`;
      row.append(swatch, label);
      elements.legendItems.append(row);
    });
  }

  function updateMetricSummary() {
    const field = currentField();
    const group = currentGroup();
    elements.metricSummary.replaceChildren();
    const strong = document.createElement("strong");
    const description = document.createElement("span");
    strong.textContent = fieldDisplayLabel(field);
    description.textContent = `${group.title} · ${isAbsoluteField(field) ? "valor absoluto" : "percentual do Total"}`;
    elements.metricSummary.append(strong, description);
    elements.mapBadgeText.textContent = truncate(fieldDisplayLabel(field), 78);
    elements.mapBadge.hidden = false;
  }

  function updateMapTheme() {
    computeTheme();
    state.geoLayer.setStyle(styleFeature);
    updateLegend();
    updateMetricSummary();
    if (state.selectedCode) updateSelectedMetric();
    updateUrl();
  }

  function populateGroupSelect() {
    elements.groupSelect.replaceChildren();
    state.census.groups.forEach((group) => {
      const option = document.createElement("option");
      option.value = group.id;
      option.textContent = `${group.id.replace("Tab", "Tabela ").replace("_", ".")} — ${truncate(compactTableTitle(group.title), 96)}`;
      elements.groupSelect.append(option);
    });
  }

  function populateMetricSelect(groupId, preferredIndex = null) {
    const group = state.groupsById.get(groupId);
    elements.metricSelect.replaceChildren();
    group.field_indexes.forEach((fieldIndex) => {
      const field = state.census.fields[fieldIndex];
      const option = document.createElement("option");
      option.value = String(fieldIndex);
      option.textContent = isAbsoluteField(field)
        ? `${field.label} · valor absoluto`
        : `${field.label} · % do Total`;
      elements.metricSelect.append(option);
    });
    const nextIndex = preferredIndex !== null && group.field_indexes.includes(preferredIndex)
      ? preferredIndex
      : group.field_indexes[0];
    elements.metricSelect.value = String(nextIndex);
    state.currentFieldIndex = nextIndex;
  }

  function chooseField(fieldIndex, closeSearch = true) {
    const field = state.census.fields[fieldIndex];
    if (!field) return;
    elements.groupSelect.value = field.group;
    populateMetricSelect(field.group, fieldIndex);
    if (closeSearch) {
      elements.variableSearch.value = "";
      elements.clearVariableSearch.hidden = true;
      elements.variableResults.replaceChildren();
    }
    updateMapTheme();
    if (state.selectedCode) renderIndicatorGroups();
  }

  function renderAreaResults(query) {
    elements.areaResults.replaceChildren();
    const normalized = normalize(query);
    elements.clearAreaSearch.hidden = !query;
    if (normalized.length < 2) return;
    const compactCode = normalized.replace(/\D/g, "");
    const matches = state.geojson.features
      .filter((feature) => {
        const properties = feature.properties;
        return normalize(properties.nm_apond).includes(normalized)
          || normalize(properties.NM_MUN).includes(normalized)
          || (compactCode && String(properties.cd_apond).includes(compactCode));
      })
      .sort((a, b) => {
        const aExact = normalize(a.properties.NM_MUN) === normalized || normalize(a.properties.nm_apond) === normalized;
        const bExact = normalize(b.properties.NM_MUN) === normalized || normalize(b.properties.nm_apond) === normalized;
        if (aExact !== bExact) return aExact ? -1 : 1;
        return String(a.properties.NM_MUN).localeCompare(String(b.properties.NM_MUN), "pt-BR");
      })
      .slice(0, 10);

    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "empty-result";
      empty.textContent = "Nenhuma área encontrada.";
      elements.areaResults.append(empty);
      return;
    }
    matches.forEach((feature) => {
      const button = document.createElement("button");
      const name = document.createElement("strong");
      const place = document.createElement("span");
      const code = document.createElement("small");
      button.type = "button";
      button.className = "search-result";
      button.setAttribute("role", "option");
      name.textContent = feature.properties.nm_apond || `Área ${feature.properties.cd_apond}`;
      place.textContent = feature.properties.NM_MUN;
      code.textContent = feature.properties.cd_apond;
      button.append(name, place, code);
      button.addEventListener("click", () => selectArea(feature.properties.cd_apond, true));
      elements.areaResults.append(button);
    });
  }

  function renderVariableResults(query) {
    elements.variableResults.replaceChildren();
    const normalized = normalize(query);
    elements.clearVariableSearch.hidden = !query;
    if (normalized.length < 2) return;
    const matches = state.census.fields
      .filter((field) => {
        const group = state.groupsById.get(field.group);
        return normalize(field.label).includes(normalized) || normalize(group.title).includes(normalized);
      })
      .slice(0, 12);
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "empty-result";
      empty.textContent = "Nenhuma variável encontrada.";
      elements.variableResults.append(empty);
      return;
    }
    matches.forEach((field) => {
      const group = state.groupsById.get(field.group);
      const button = document.createElement("button");
      const label = document.createElement("strong");
      const table = document.createElement("span");
      button.type = "button";
      button.className = "search-result";
      button.setAttribute("role", "option");
      label.textContent = fieldDisplayLabel(field);
      table.textContent = `${field.group.replace("Tab", "Tabela ").replace("_", ".")} · ${truncate(compactTableTitle(group.title), 70)}`;
      button.append(label, table);
      button.addEventListener("click", () => chooseField(field.index));
      elements.variableResults.append(button);
    });
  }

  function updateSelectedMetric() {
    const feature = state.featuresByCode.get(state.selectedCode);
    if (!feature) return;
    const field = currentField();
    const group = currentGroup();
    elements.selectedMetricLabel.textContent = fieldDisplayLabel(field);
    elements.selectedMetricValue.textContent = formatDisplayValue(valueForFeature(feature), field);
    elements.selectedMetricTable.textContent = `${group.title} · ${isAbsoluteField(field) ? "valor absoluto" : "percentual do Total"}`;
  }

  function renderIndicatorGroups() {
    const feature = state.featuresByCode.get(state.selectedCode);
    if (!feature) return;
    const row = state.census.rows[feature.properties.data_index];
    const filter = normalize(elements.detailSearch.value);
    const fragment = document.createDocumentFragment();
    let shown = 0;

    state.census.groups.forEach((group) => {
      const matchingIndexes = group.field_indexes.filter((fieldIndex) => {
        const field = state.census.fields[fieldIndex];
        return !filter || normalize(field.label).includes(filter) || normalize(group.title).includes(filter);
      });
      if (!matchingIndexes.length) return;
      shown += matchingIndexes.length;

      const details = document.createElement("details");
      const summary = document.createElement("summary");
      const title = document.createElement("strong");
      const meta = document.createElement("span");
      const list = document.createElement("dl");
      details.className = "indicator-group";
      details.open = Boolean(filter) || group.id === currentField().group;
      title.textContent = compactTableTitle(group.title);
      meta.textContent = `${group.id.replace("Tab", "Tabela ").replace("_", ".")} · ${matchingIndexes.length} ${matchingIndexes.length === 1 ? "indicador" : "indicadores"}`;
      summary.append(title, meta);
      list.className = "indicator-list";

      matchingIndexes.forEach((fieldIndex) => {
        const field = state.census.fields[fieldIndex];
        const wrapper = document.createElement("div");
        const term = document.createElement("dt");
        const value = document.createElement("dd");
        wrapper.className = "indicator-row";
        if (fieldIndex === state.currentFieldIndex) wrapper.classList.add("highlighted");
        term.textContent = field.label;
        value.textContent = formatDisplayValue(valueFromRow(row, fieldIndex), field);
        wrapper.append(term, value);
        list.append(wrapper);
      });
      details.append(summary, list);
      fragment.append(details);
    });

    elements.indicatorGroups.replaceChildren();
    if (!shown) {
      const empty = document.createElement("div");
      empty.className = "no-indicators";
      empty.textContent = "Nenhum indicador corresponde ao filtro.";
      elements.indicatorGroups.append(empty);
    } else {
      elements.indicatorGroups.append(fragment);
    }
  }

  function renderDetails() {
    const feature = state.featuresByCode.get(state.selectedCode);
    if (!feature) return;
    const properties = feature.properties;
    elements.emptyDetails.hidden = true;
    elements.detailsContent.hidden = false;
    elements.detailsPanel.classList.add("open");
    elements.detailName.textContent = properties.nm_apond || `Área ${properties.cd_apond}`;
    elements.detailMunicipality.textContent = `${properties.NM_MUN} · São Paulo`;
    elements.detailCode.textContent = `Código ${properties.cd_apond}`;
    elements.detailArea.textContent = `${ptArea.format(properties.AREA_KM2)} km²`;
    elements.detailSectors.textContent = `${ptInteger.format(properties.Qt_SetCensit)} ${properties.Qt_SetCensit === 1 ? "setor" : "setores"}`;
    updateSelectedMetric();
    renderIndicatorGroups();
  }

  function selectArea(code, zoomToArea = false) {
    const feature = state.featuresByCode.get(String(code));
    if (!feature) return;
    const previousCode = state.selectedCode;
    state.selectedCode = String(code);
    if (previousCode && state.layersByCode.has(previousCode)) {
      state.layersByCode.get(previousCode).setStyle(styleFeature(state.featuresByCode.get(previousCode)));
    }
    const layer = state.layersByCode.get(state.selectedCode);
    layer.setStyle(styleFeature(feature));
    layer.bringToFront();
    if (zoomToArea) {
      state.map.fitBounds(layer.getBounds(), { padding: [36, 36], maxZoom: 12, animate: true });
    }
    elements.areaSearch.value = "";
    elements.clearAreaSearch.hidden = true;
    elements.areaResults.replaceChildren();
    elements.detailSearch.value = "";
    elements.controlPanel.classList.remove("open");
    renderDetails();
    updateUrl();
  }

  function clearSelection() {
    const oldCode = state.selectedCode;
    state.selectedCode = null;
    if (oldCode && state.layersByCode.has(oldCode)) {
      state.layersByCode.get(oldCode).setStyle(styleFeature(state.featuresByCode.get(oldCode)));
    }
    elements.detailsPanel.classList.remove("open");
    elements.detailsContent.hidden = true;
    elements.emptyDetails.hidden = false;
    updateUrl();
  }

  function updateUrl() {
    if (!state.census) return;
    const params = new URLSearchParams();
    params.set("v", String(state.currentFieldIndex));
    if (state.selectedCode) params.set("area", state.selectedCode);
    const nextHash = params.toString();
    if (window.location.hash.slice(1) !== nextHash) history.replaceState(null, "", `#${nextHash}`);
  }

  function readInitialState() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const fieldIndex = Number(params.get("v"));
    const areaCode = params.get("area");
    return {
      fieldIndex: Number.isInteger(fieldIndex) && fieldIndex >= 0 && fieldIndex < state.census.fields.length ? fieldIndex : 0,
      areaCode,
    };
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 4500);
  }

  async function loadChunkedJson(assetName) {
    const manifestResponse = await fetch(`./data/${assetName}.manifest.json?v=5`);
    if (!manifestResponse.ok) throw new Error(`Falha ao carregar o manifesto de ${assetName}.`);
    const manifest = await manifestResponse.json();
    if (manifest.format !== "utf8-json-parts-v1" || !Array.isArray(manifest.parts) || !manifest.parts.length) {
      throw new Error(`Manifesto de ${assetName} inválido.`);
    }

    const responses = await Promise.all(
      manifest.parts.map((part) => fetch(`./data/${part}?v=5`)),
    );
    if (responses.some((response) => !response.ok)) {
      throw new Error(`Falha ao carregar uma parte de ${assetName}.`);
    }
    const buffers = await Promise.all(responses.map((response) => response.arrayBuffer()));
    const byteLength = buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
    if (byteLength !== manifest.bytes) throw new Error(`Dados incompletos em ${assetName}.`);

    const joined = new Uint8Array(byteLength);
    let offset = 0;
    buffers.forEach((buffer) => {
      joined.set(new Uint8Array(buffer), offset);
      offset += buffer.byteLength;
    });
    return JSON.parse(new TextDecoder("utf-8").decode(joined));
  }

  function downloadGeoJson() {
    const blob = new Blob([JSON.stringify(state.geojson)], { type: "application/geo+json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "areas-ponderacao-sp.geojson";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function bindControls() {
    elements.areaSearch.addEventListener("input", (event) => renderAreaResults(event.target.value));
    elements.clearAreaSearch.addEventListener("click", () => {
      elements.areaSearch.value = "";
      elements.areaResults.replaceChildren();
      elements.clearAreaSearch.hidden = true;
      elements.areaSearch.focus();
    });
    elements.variableSearch.addEventListener("input", (event) => renderVariableResults(event.target.value));
    elements.clearVariableSearch.addEventListener("click", () => {
      elements.variableSearch.value = "";
      elements.variableResults.replaceChildren();
      elements.clearVariableSearch.hidden = true;
      elements.variableSearch.focus();
    });
    elements.groupSelect.addEventListener("change", (event) => {
      populateMetricSelect(event.target.value);
      updateMapTheme();
      if (state.selectedCode) renderIndicatorGroups();
    });
    elements.metricSelect.addEventListener("change", (event) => chooseField(Number(event.target.value), false));
    elements.detailSearch.addEventListener("input", renderIndicatorGroups);
    elements.detailsClose.addEventListener("click", clearSelection);
    elements.resetView.addEventListener("click", () => state.map.fitBounds(state.stateBounds, { padding: [16, 16] }));
    elements.filtersToggle.addEventListener("click", () => elements.controlPanel.classList.add("open"));
    elements.filtersClose.addEventListener("click", () => elements.controlPanel.classList.remove("open"));
    elements.aboutButton.addEventListener("click", () => elements.aboutDialog.showModal());
    elements.downloadGeoJson.addEventListener("click", downloadGeoJson);
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".search-group")) elements.areaResults.replaceChildren();
      if (!event.target.closest(".variable-search-group")) elements.variableResults.replaceChildren();
    });
  }

  function initializeMap() {
    state.map = L.map("map", {
      zoomControl: false,
      preferCanvas: true,
      minZoom: 5,
      maxZoom: 15,
      maxBounds: [[-27.2, -56.2], [-17.0, -42.2]],
      maxBoundsViscosity: 0.7,
    });
    L.control.zoom({ position: "bottomright" }).addTo(state.map);
    L.control.scale({ position: "bottomleft", imperial: false, maxWidth: 120 }).addTo(state.map);
    state.map.attributionControl.setPrefix("Leaflet 1.9.4");
    state.map.attributionControl.addAttribution("Geometrias e dados: IBGE · base vetorial local");

    state.map.createPane("localBase");
    state.map.getPane("localBase").style.zIndex = 180;
    state.map.getPane("localBase").style.pointerEvents = "none";
    const gridStyle = {
      pane: "localBase",
      color: "#9aacba",
      weight: 1,
      opacity: 0.38,
      dashArray: "2 7",
      interactive: false,
    };
    for (let latitude = -26; latitude <= -18; latitude += 2) {
      L.polyline([[latitude, -56.2], [latitude, -42.2]], gridStyle).addTo(state.map);
    }
    for (let longitude = -54; longitude <= -44; longitude += 2) {
      L.polyline([[-27.2, longitude], [-17, longitude]], gridStyle).addTo(state.map);
    }
  }

  function addGeoJson() {
    const renderer = L.canvas({ padding: 0.5, tolerance: 4 });
    state.geoLayer = L.geoJSON(state.geojson, {
      renderer,
      style: styleFeature,
      onEachFeature: (feature, layer) => {
        const code = String(feature.properties.cd_apond);
        state.featuresByCode.set(code, feature);
        state.layersByCode.set(code, layer);
        layer.bindTooltip(() => tooltipContent(feature), {
          className: "area-tooltip",
          sticky: true,
          direction: "top",
          opacity: 1,
        });
        layer.on({
          click: () => selectArea(code, false),
          mouseover: () => {
            if (state.selectedCode !== code) layer.setStyle({ color: "#0b1727", weight: 1.5, opacity: 1 });
          },
          mouseout: () => {
            if (state.selectedCode !== code) layer.setStyle(styleFeature(feature));
          },
        });
      },
    }).addTo(state.map);
    state.stateBounds = state.geoLayer.getBounds();
    state.map.fitBounds(state.stateBounds, { padding: [12, 12] });
  }

  async function start() {
    try {
      if (!window.L) throw new Error("A biblioteca local de mapas não pôde ser carregada.");
      initializeMap();
      [state.geojson, state.census] = await Promise.all([
        loadChunkedJson("aponds-sp.geojson"),
        loadChunkedJson("censo-variables.json"),
      ]);
      state.census.groups.forEach((group) => state.groupsById.set(group.id, group));
      elements.areaCount.textContent = ptInteger.format(state.geojson.features.length);
      elements.variableCount.textContent = ptInteger.format(state.census.fields.length);
      populateGroupSelect();
      const initial = readInitialState();
      state.currentFieldIndex = initial.fieldIndex;
      const initialField = currentField();
      elements.groupSelect.value = initialField.group;
      populateMetricSelect(initialField.group, initial.fieldIndex);
      computeTheme();
      addGeoJson();
      updateLegend();
      updateMetricSummary();
      bindControls();
      if (initial.areaCode && state.featuresByCode.has(initial.areaCode)) selectArea(initial.areaCode, true);
      elements.loadingState.classList.add("hidden");
      window.setTimeout(() => elements.loadingState.remove(), 280);
    } catch (error) {
      console.error(error);
      elements.loadingState.querySelector("strong").textContent = "Não foi possível abrir o mapa";
      elements.loadingState.querySelector("span").textContent = "Recarregue a página para tentar novamente.";
      showToast(error.message || "Erro ao carregar o mapa.");
    }
  }

  window.addEventListener("DOMContentLoaded", start);
})();

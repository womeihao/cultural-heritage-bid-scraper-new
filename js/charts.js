/**
 * charts.js — ECharts 图表渲染模块
 * heritage-analysis 仪表盘: 环形饼图 / 六维雷达图 / 年度柱状图 / Top10条形图
 */

const ChartsManager = {
  instances: {},       // { id: echartsInstance }
  containerIds: ["chart-pie", "chart-radar", "chart-bar", "chart-top"],

  /** 创建/获取 chart 实例 */
  getOrCreate(chartId) {
    const el = document.getElementById(chartId);
    if (!el) return null;
    if (this.instances[chartId]) {
      this.instances[chartId].dispose();
    }
    const instance = echarts.init(el);
    this.instances[chartId] = instance;
    return instance;
  },

  /** 销毁所有实例 */
  disposeAll() {
    Object.values(this.instances).forEach(c => c.dispose());
    this.instances = {};
    // 清空图表容器HTML
    this.containerIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = "";
    });
  },

  /** 渲染省份仪表盘 */
  renderProvinceCharts(chartsData) {
    this.disposeAll(); // 切换省时清除旧图表

    if (!chartsData) return;

    this._renderPie(chartsData.pie);
    this._renderRadar(chartsData.radar);
    this._renderBar(chartsData.bar);
    this._renderTop(chartsData.top_museums, chartsData.top_suppliers);
  },

  /* ─── 环形饼图: 业务类型分布 ─── */
  _renderPie(pieData) {
    const chart = this.getOrCreate("chart-pie");
    if (!chart || !pieData || !pieData.length) return;

    const option = {
      tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
      legend: { orient: "vertical", right: 10, top: 20, textStyle: { fontSize: 11 } },
      series: [{
        name: "业务类型", type: "pie",
        radius: ["40%", "70%"],
        center: ["35%", "50%"],
        avoidLabelOverlap: false,
        itemStyle: { borderRadius: 4, borderColor: "#fff", borderWidth: 2 },
        label: { show: true, position: "outside", formatter: "{b}\\n{d}%", fontSize: 10 },
        data: pieData.map(d => ({ name: d.name, value: d.value })),
      }]
    };
    chart.setOption(option);
  },

  /* ─── 六维雷达图: 数字化能力覆盖 ─── */
  _renderRadar(radarData) {
    const chart = this.getOrCreate("chart-radar");
    if (!chart || !radarData || !radarData.length) return;

    const indicators = radarData.map(d => ({ name: d.name, max: Math.max(...radarData.map(r => r.value), 1) * 1.3 }));
    const option = {
      tooltip: {},
      radar: { indicator: indicators, center: ["50%", "55%"], radius: "65%" },
      series: [{
        type: "radar",
        data: [{ value: radarData.map(d => d.value), name: "数字化能力", areaStyle: { color: "rgba(41,128,185,0.2)" } }]
      }]
    };
    chart.setOption(option);
  },

  /* ─── 年度柱状图: 项目数+金额双轴 ─── */
  _renderBar(barData) {
    const chart = this.getOrCreate("chart-bar");
    if (!chart || !barData || !barData.years) return;

    const option = {
      tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
      legend: { data: ["项目数", "金额(万)"] },
      xAxis: { type: "category", data: barData.years.map(String) },
      yAxis: [
        { type: "value", name: "项目数" },
        { type: "value", name: "金额(万)" }
      ],
      series: [
        { name: "项目数", type: "bar", data: barData.counts, itemStyle: { color: "#2980b9" } },
        { name: "金额(万)", type: "line", yAxisIndex: 1, data: barData.amounts, lineStyle: { color: "#e74c3c" }, itemStyle: { color: "#e74c3c" } }
      ]
    };
    chart.setOption(option);
  },

  /* ─── 横向条形图Top10 (左上博物馆排名 + 右下供应商排名) ─── */
  _renderTop(topMuseums, topSuppliers) {
    const chart = this.getOrCreate("chart-top");
    if (!chart) return;

    // 合并为双系列bar
    const museumNames = (topMuseums || []).map(m => m.name).reverse();
    const museumCounts = (topMuseums || []).map(m => m.count).reverse();
    const supplierNames = (topSuppliers || []).map(s => s.name).reverse();
    const supplierAmounts = (topSuppliers || []).map(s => s.amount).reverse();

    const option = {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend: { data: ["博物馆项目数", "供应商金额(万)"] },
      grid: [{ left: "5%", top: 40, width: "42%", bottom: 10 }, { left: "55%", top: 40, width: "42%", bottom: 10 }],
      xAxis: [
        { type: "value", gridIndex: 0, name: "项目数" },
        { type: "value", gridIndex: 1, name: "金额(万)" }
      ],
      yAxis: [
        { type: "category", gridIndex: 0, data: museumNames, axisLabel: { fontSize: 10 } },
        { type: "category", gridIndex: 1, data: supplierNames, axisLabel: { fontSize: 10 } }
      ],
      series: [
        { name: "博物馆项目数", type: "bar", xAxisIndex: 0, yAxisIndex: 0, data: museumCounts, itemStyle: { color: "#2980b9" } },
        { name: "供应商金额(万)", type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: supplierAmounts, itemStyle: { color: "#e67e22" } }
      ]
    };
    chart.setOption(option);
  },

  /** 响应式 resize */
  resizeAll() {
    Object.values(this.instances).forEach(c => c.resize());
  }
};

// 监听 resize
window.addEventListener("resize", () => ChartsManager.resizeAll());

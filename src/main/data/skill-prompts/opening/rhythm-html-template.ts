/**
 * 节奏图谱.html 模版（源自《小说立项》技能 v3.2 硬性规定）。
 * 支持「正文写作」技能回填实际情绪值（actualized=true），图表区分实际值（实线）和预测值（虚线），
 * 并集成 6 类违规节奏检查及控制台日志记录。
 */
export const RHYTHM_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>《__BOOK_NAME__》节奏图谱</title>
    <!--
        版本：v1.0（__CREATE_DATE__ 创建）
        回填说明：本文件支持「正文写作」技能在每章写完后回填实际情绪值。
        - rhythmData 数组每行格式：{ chapter, title, emotion, climax, volume, actualized }
        - actualized: false = 细纲预测值（细纲生成时）/ actualized: true = 实际值（写作回填后）
        - 回填时只改 emotion / climax / actualized 三个字段，保留 chapter / title / volume 不动
        - 违规检查只对 actualized=true 的章节做判定
        - ECharts 渲染时：实线+实心点 = 实际值；虚线+空心点 = 预测值
    -->
    <script src="https://cdn.jsdelivr.net/npm/echarts/dist/echarts.min.js"></script>
    <style>
        body { font-family: 'Microsoft YaHei', sans-serif; max-width: 1400px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
        h1 { color: #2c3e50; border-bottom: 3px solid #e74c3c; padding-bottom: 10px; }
        .section { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .stat { display: inline-block; padding: 8px 16px; margin: 4px; border-radius: 4px; background: #ecf0f1; }
        .stat-warn { background: #e74c3c; color: white; }
        .stat-ok { background: #27ae60; color: white; }
        .stat-info { background: #3498db; color: white; }
        #chart { width: 100%; height: 500px; }
        table { border-collapse: collapse; width: 100%; margin-top: 10px; font-size: 14px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: center; }
        th { background: #34495e; color: white; }
        tr.violation { background: #ffe6e6; }
        tr.highlight { background: #fff3cd; }
        tr.actualized { background: #e8f5e9; }   /* 已回填用浅绿色背景 */
        tr.forecast { color: #999; }              /* 预测值用灰色文字 */
    </style>
</head>
<body>
    <h1>《__BOOK_NAME__》节奏图谱</h1>

    <div class="section">
        <h2>总体统计</h2>
        <span class="stat">总章节数：<b>__TOTAL_CHAPTERS__</b></span>
        <span class="stat stat-info">已回填：<b>0</b> 章</span>
        <span class="stat">预测值：<b>0</b> 章</span>
        <span class="stat">小打脸：<b>0</b> 章</span>
        <span class="stat">中打脸：<b>0</b> 章</span>
        <span class="stat">大高潮：<b>0</b> 章</span>
        <span class="stat">卷中决战：<b>0</b> 章</span>
        <span class="stat">卷终决战：<b>0</b> 章</span>
        <span class="stat">无爽点：<b>0</b> 章</span>
        <span class="stat stat-warn">已回填章节违规：<b>0</b> 处</span>
        <span class="stat stat-ok">节奏合规：✓</span>
    </div>

    <div class="section">
        <h2>情绪曲线 + 爽点分布</h2>
        <p style="color:#666; font-size:13px;">实线+实心点 = 实际值（已回填）｜虚线+空心点 = 预测值（未回填）</p>
        <div id="chart"></div>
    </div>

    <div class="section">
        <h2>逐章节奏表</h2>
        <table>
            <thead>
                <tr>
                    <th>章节</th>
                    <th>标题</th>
                    <th>情绪值</th>
                    <th>爽点类型</th>
                    <th>卷</th>
                    <th>状态（回填/预测）</th>
                    <th>违规</th>
                </tr>
            </thead>
            <tbody id="chapter-table">
                <!-- 由脚本生成 -->
            </tbody>
        </table>
    </div>

    <script>
        // ========== 节奏数据（细纲生成后填入）==========
        // 字段顺序固定：chapter → title → emotion → climax → volume → actualized
        // 写作回填时只改 emotion / climax / actualized 三个字段
        const rhythmData = [
__RHYTHM_ENTRIES__
        ];

        const climaxLabels = ['无爽点', '小打脸', '中打脸', '大高潮', '卷中决战', '卷终决战'];
        const climaxColors = ['#95a5a6', '#3498db', '#f39c12', '#e74c3c', '#8e44ad', '#c0392b'];

        // 统一处理 climax 数值（含 3.5 卷中决战），避免 Math.round 误判
        function getClimaxIdx(c) {
            if (c >= 4) return 5;       // 卷终决战
            if (c >= 3.25) return 4;    // 卷中决战（3.5）
            if (c >= 3) return 3;       // 大高潮
            if (c >= 2) return 2;       // 中打脸
            if (c >= 1) return 1;       // 小打脸
            return 0;                   // 无爽点
        }
        function isFinal(c) { return getClimaxIdx(c) === 5; }
        function isMidFinal(c) { return getClimaxIdx(c) === 4; }
        function isPeak(c) { return getClimaxIdx(c) >= 3; }

        // 判定是否已回填（兼容缺省字段，默认 false）
        function isActualized(d) { return d.actualized === true; }

        // ========== Logger 机制（排查回填逻辑用）==========
        const logger = (() => {
            const STATE = { enabled: true, filter: null, history: [] };
            const ts = () => new Date().toISOString().split('T')[1].replace('Z', '');
            const fmt = (level, tag, msg, extra) => {
                const line = \`[\${ts()}] [\${level}] [\${tag}] \${msg}\` +
                    (extra ? ' | ' + JSON.stringify(extra) : '');
                STATE.history.push(line);
                if (STATE.history.length > 500) STATE.history.shift();
                if (STATE.enabled && (!STATE.filter || line.includes(STATE.filter))) {
                    const fn = level === 'ERROR' ? console.error
                             : level === 'WARN'  ? console.warn
                             : console.log;
                    fn(line);
                }
            };
            return {
                info:    (tag, msg, extra) => fmt('INFO',  tag, msg, extra),
                warn:    (tag, msg, extra) => fmt('WARN',  tag, msg, extra),
                error:   (tag, msg, extra) => fmt('ERROR', tag, msg, extra),
                debug:   (tag, msg, extra) => fmt('DEBUG', tag, msg, extra),
                toggle:  () => { STATE.enabled = !STATE.enabled; console.log('[logger] enabled =', STATE.enabled); },
                filter:  (k) => { STATE.filter = k; console.log('[logger] filter =', k || '(none)'); },
                clear:   () => { STATE.history = []; console.clear(); },
                dump:    () => console.log('[logger history]\\n' + STATE.history.join('\\n')),
                history: () => STATE.history.slice()
            };
        })();

        // ========== 节奏检查（仅对已回填章节判定）==========
        function checkRhythm(data) {
            logger.info('checkRhythm', '===== 开始检查 =====', {
                totalChapters: data.length,
                actualizedCount: data.filter(isActualized).length,
                forecastCount: data.filter(d => !isActualized(d)).length
            });

            const violations = [];

            // 入口防御性检查：找出已回填但缺字段的章节
            const invalidActualized = data.filter(d =>
                isActualized(d) && (d.emotion === undefined || d.climax === undefined)
            );
            if (invalidActualized.length > 0) {
                logger.error('checkRhythm', '已回填章节存在缺字段（这些章节将被跳过，不参与违规判定）', {
                    invalidChapters: invalidActualized.map(d => d.chapter),
                    details: invalidActualized.map(d => ({
                        chapter: d.chapter,
                        title: d.title,
                        hasEmotion: d.emotion !== undefined,
                        hasClimax: d.climax !== undefined
                    }))
                });
                logger.warn('checkRhythm', \`已跳过 \${invalidActualized.length} 个缺字段的已回填章节\`, {
                    skipped: invalidActualized.map(d => d.chapter)
                });
            }

            const actualizedData = data.filter(d =>
                isActualized(d) && d.emotion !== undefined && d.climax !== undefined
            );
            const forecastData = data.filter(d => !isActualized(d));

            logger.info('checkRhythm', '数据拆分', {
                actualized: actualizedData.map(d => d.chapter),
                forecast: forecastData.map(d => d.chapter)
            });

            // 违规类型 1：连续 2 章爽点类型 = 0（仅检查已回填章节）
            logger.debug('checkRhythm', '【违规1】开始扫描连续无爽点', {
                scanRange: actualizedData.length > 0 ? \`第\${actualizedData[0].chapter}-\\第\${actualizedData[actualizedData.length-1].chapter}章\` : '空'
            });
            for (let i = 0; i < actualizedData.length - 1; i++) {
                const c1 = actualizedData[i], c2 = actualizedData[i + 1];
                const climax1 = getClimaxIdx(c1.climax), climax2 = getClimaxIdx(c2.climax);
                if (climax1 === 0 && climax2 === 0) {
                    logger.warn('checkRhythm', '【违规1】命中：连续 2 章无爽点', {
                        chapter1: c1.chapter, title1: c1.title, climax1: c1.climax,
                        chapter2: c2.chapter, title2: c2.title, climax2: c2.climax
                    });
                    violations.push({ chapter: c1.chapter, type: '无爽点', msg: '已回填章节连续 2 章无爽点' });
                    violations.push({ chapter: c2.chapter, type: '无爽点', msg: '已回填章节连续 2 章无爽点' });
                }
            }
            logger.debug('checkRhythm', '【违规1】扫描完成', { violationsAdded: violations.filter(v => v.type === '无爽点').length });

            // 违规类型 2：相邻大高潮（含卷中/卷终决战）间隔 > 15 章（仅检查已回填章节）
            logger.debug('checkRhythm', '【违规2】开始扫描大高潮间隔');
            let lastPeak = -1, lastPeakInfo = null;
            actualizedData.forEach(d => {
                if (isPeak(d.climax)) {
                    if (lastPeak !== -1 && d.chapter - lastPeak > 15) {
                        logger.warn('checkRhythm', '【违规2】命中：相邻大高潮间隔 > 15 章', {
                            prevChapter: lastPeak, prevTitle: lastPeakInfo.title, prevClimax: lastPeakInfo.climax,
                            currChapter: d.chapter, currTitle: d.title, currClimax: d.climax,
                            gap: d.chapter - lastPeak
                        });
                        violations.push({
                            chapter: lastPeak,
                            type: '高潮拖沓',
                            msg: '已回填章节：与下一高潮间隔 ' + (d.chapter - lastPeak) + ' 章，超过 15 章上限'
                        });
                    }
                    lastPeak = d.chapter;
                    lastPeakInfo = d;
                }
            });
            logger.debug('checkRhythm', '【违规2】扫描完成', { violationsAdded: violations.filter(v => v.type === '高潮拖沓').length });

            // 违规类型 3：卷终决战情绪值 < 10（仅检查已回填章节）
            logger.debug('checkRhythm', '【违规3】开始扫描卷终决战情绪值');
            actualizedData.forEach(d => {
                if (isFinal(d.climax) && d.emotion < 10) {
                    logger.warn('checkRhythm', '【违规3】命中：卷终决战情绪值 < 10', {
                        chapter: d.chapter, title: d.title, volume: d.volume,
                        emotion: d.emotion, climax: d.climax
                    });
                    violations.push({ chapter: d.chapter, type: '卷终未达高潮', msg: '已回填章节：卷终决战情绪值 ' + d.emotion + '，应 = 10' });
                }
            });
            logger.debug('checkRhythm', '【违规3】扫描完成', { violationsAdded: violations.filter(v => v.type === '卷终未达高潮').length });

            // 违规类型 4：同一卷出现 2 次以上卷终决战（仅检查已回填章节）
            logger.debug('checkRhythm', '【违规4】开始统计每卷卷终决战次数');
            const volumeFinals = {};
            actualizedData.forEach(d => {
                if (isFinal(d.climax)) {
                    volumeFinals[d.volume] = (volumeFinals[d.volume] || 0) + 1;
                }
            });
            logger.debug('checkRhythm', '【违规4】卷终决战统计', { volumeFinals });
            actualizedData.forEach(d => {
                if (isFinal(d.climax) && volumeFinals[d.volume] > 1) {
                    logger.warn('checkRhythm', '【违规4】命中：同卷多次卷终决战', {
                        chapter: d.chapter, title: d.title, volume: d.volume,
                        climax: d.climax, countInVolume: volumeFinals[d.volume]
                    });
                    violations.push({ chapter: d.chapter, type: '卷终重复', msg: '已回填章节：第 ' + d.volume + ' 卷出现 ' + volumeFinals[d.volume] + ' 次卷终决战' });
                }
            });
            logger.debug('checkRhythm', '【违规4】扫描完成', { violationsAdded: violations.filter(v => v.type === '卷终重复').length });

            // 违规类型 5：第 1 章就出现大高潮/卷终决战（仅检查已回填章节）
            logger.debug('checkRhythm', '【违规5】检查第 1 章（已回填章节中的首章）');
            if (actualizedData.length > 0 && isPeak(actualizedData[0].climax)) {
                logger.warn('checkRhythm', '【违规5】命中：第 1 章大高潮/卷终决战', {
                    chapter: actualizedData[0].chapter, title: actualizedData[0].title,
                    climax: actualizedData[0].climax, climaxIdx: getClimaxIdx(actualizedData[0].climax)
                });
                violations.push({ chapter: actualizedData[0].chapter, type: '开篇过曝', msg: '已回填章节：第 1 章爽点强度 ' + getClimaxIdx(actualizedData[0].climax) + '，应 ≤ 2（中打脸）' });
            }

            // 违规类型 6：卷中决战出现在 < 35 章的短/中卷（仅检查已回填章节）
            logger.debug('checkRhythm', '【违规6】开始扫描卷中决战是否在长卷');
            actualizedData.forEach(d => {
                if (isMidFinal(d.climax)) {
                    const volumeChapters = data.filter(x => x.volume === d.volume);
                    if (volumeChapters.length < 35) {
                        logger.warn('checkRhythm', '【违规6】命中：卷中决战在短/中卷', {
                            chapter: d.chapter, title: d.title, volume: d.volume,
                            climax: d.climax, volumeLength: volumeChapters.length
                        });
                        violations.push({ chapter: d.chapter, type: '卷中决战过早', msg: '已回填章节：卷中决战仅允许 35+ 章长卷使用，当前卷仅 ' + volumeChapters.length + ' 章' });
                    }
                }
            });
            logger.debug('checkRhythm', '【违规6】扫描完成', { violationsAdded: violations.filter(v => v.type === '卷中决战过早').length });

            logger.info('checkRhythm', '===== 检查完成 =====', {
                totalViolations: violations.length,
                violationsByType: violations.reduce((acc, v) => {
                    acc[v.type] = (acc[v.type] || 0) + 1;
                    return acc;
                }, {})
            });

            return violations;
        }

        // ========== ECharts 图表（区分实际/预测）==========
        const chart = echarts.init(document.getElementById('chart'));
        const chapters = rhythmData.map(d => '第' + d.chapter + '章');

        chart.setOption({
            title: { text: '情绪曲线 & 爽点分布', left: 'center' },
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'cross' },
                formatter: function(params) {
                    let res = params[0].axisValue + '<br/>';
                    params.forEach(p => {
                        const isAct = rhythmData[p.dataIndex] && isActualized(rhythmData[p.dataIndex]);
                        res += p.marker + p.seriesName + ': ' + p.value + (isAct ? ' （实际）' : ' （预测）') + '<br/>';
                    });
                    return res;
                }
            },
            legend: { data: ['情绪曲线（实际）', '情绪曲线（预测）', '爽点强度'], top: 30 },
            grid: { left: 60, right: 60, bottom: 80, top: 80 },
            xAxis: { type: 'category', data: chapters, axisLabel: { rotate: 45 } },
            yAxis: [
                { type: 'value', name: '情绪值', min: 0, max: 10, position: 'left' },
                { type: 'value', name: '爽点强度', min: 0, max: 4, position: 'right' }
            ],
            series: [
                {
                    name: '情绪曲线（实际）',
                    type: 'line',
                    data: rhythmData.map((d, i) => isActualized(d) ? d.emotion : null),
                    smooth: true,
                    lineStyle: { width: 3, color: '#e74c3c' },
                    itemStyle: { color: '#e74c3c' },
                    connectNulls: false,
                    symbol: 'circle',
                    symbolSize: 8
                },
                {
                    name: '情绪曲线（预测）',
                    type: 'line',
                    data: rhythmData.map((d, i) => isActualized(d) ? null : d.emotion),
                    smooth: true,
                    lineStyle: { width: 2, color: '#95a5a6', type: 'dashed' },
                    itemStyle: { color: '#95a5a6' },
                    connectNulls: true,
                    symbol: 'circle',
                    symbolSize: 6
                },
                {
                    name: '爽点强度',
                    type: 'bar',
                    yAxisIndex: 1,
                    data: rhythmData.map((d, i) => ({
                        value: d.climax,
                        itemStyle: {
                            color: climaxColors[getClimaxIdx(d.climax)],
                            opacity: isActualized(d) ? 1 : 0.4
                        }
                    })),
                    barWidth: 8
                }
            ]
        });

        // ========== 逐章表格 ==========
        const violations = checkRhythm(rhythmData);
        const violationMap = new Map();
        violations.forEach(v => {
            if (!violationMap.has(v.chapter)) violationMap.set(v.chapter, []);
            violationMap.get(v.chapter).push(v);
        });

        logger.info('table', '违规映射表已构建', {
            violationChapters: Array.from(violationMap.keys())
        });

        const tbody = document.getElementById('chapter-table');
        rhythmData.forEach(d => {
            const tr = document.createElement('tr');
            const v = violationMap.get(d.chapter);
            const isViolation = !!v;
            const climaxIdx = getClimaxIdx(d.climax);
            const actualized = isActualized(d);

            if (isViolation) tr.className = 'violation';
            else if (actualized) tr.className = 'actualized';
            else if (isPeak(d.climax)) tr.className = 'highlight forecast';
            else tr.className = 'forecast';

            const climaxText = climaxLabels[climaxIdx];
            const statusText = actualized ? '✅ 已回填' : '⏳ 预测值';
            const violationText = isViolation
                ? '⚠️ ' + v.map(x => x.type).join('/')
                : '—';

            if (actualized && d.emotion === undefined) {
                logger.error('table', '已回填章节缺 emotion 字段', { chapter: d.chapter, data: d });
            }
            if (actualized && d.climax === undefined) {
                logger.error('table', '已回填章节缺 climax 字段', { chapter: d.chapter, data: d });
            }

            tr.innerHTML = \`
                <td>第\${d.chapter}章</td>
                <td>\${d.title}</td>
                <td>\${d.emotion}</td>
                <td>\${climaxText}</td>
                <td>第\${d.volume}卷</td>
                <td>\${statusText}</td>
                <td>\${violationText}</td>
            \`;
            tbody.appendChild(tr);
        });
        logger.info('table', '逐章表格渲染完成', { rowCount: rhythmData.length });

        // 违规详情区
        if (violations.length > 0) {
            const detailSection = document.createElement('div');
            detailSection.className = 'section';
            detailSection.innerHTML = '<h2>违规详情（仅已回填章节）</h2><ul>' +
                violations.map(v => \`<li>第 <b>\${v.chapter}</b> 章 - <b style="color:#e74c3c">\${v.type}</b>：\${v.msg}</li>\`).join('') +
                '</ul>';
            document.body.appendChild(detailSection);
        }

        // 统计
        const counts = [0, 0, 0, 0, 0, 0];
        let actualizedCount = 0;
        rhythmData.forEach(d => {
            counts[getClimaxIdx(d.climax)]++;
            if (isActualized(d)) actualizedCount++;
        });
        document.querySelector('.stat:nth-child(2) b').textContent = rhythmData.length;
        document.querySelector('.stat:nth-child(3) b').textContent = actualizedCount;
        document.querySelector('.stat:nth-child(4) b').textContent = rhythmData.length - actualizedCount;
        document.querySelector('.stat:nth-child(5) b').textContent = counts[1];
        document.querySelector('.stat:nth-child(6) b').textContent = counts[2];
        document.querySelector('.stat:nth-child(7) b').textContent = counts[3];
        document.querySelector('.stat:nth-child(8) b').textContent = counts[4];
        document.querySelector('.stat:nth-child(9) b').textContent = counts[5];
        document.querySelector('.stat:nth-child(10) b').textContent = counts[0];
        document.querySelector('.stat:nth-child(11) b').textContent = violations.length;
    </script>
</body>
</html>
`;

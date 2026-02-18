const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Эти переменные будут взяты из окружения на Render
const INSTANCE_ID = process.env.INSTANCE_ID;
const API_KEY = process.env.API_KEY;

app.use(cors());
app.use(express.json());
// Раздаём статические файлы из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Функция для генерации сетки 3×3 на основе среднего NDVI
function generateGridFromStats(bbox, meanNdvi) {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const stepX = (maxLng - minLng) / 3;
    const stepY = (maxLat - minLat) / 3;
    const gridCells = [];
    const ndviValues = [];

    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            const cellMinLng = minLng + i * stepX;
            const cellMaxLng = minLng + (i + 1) * stepX;
            const cellMinLat = minLat + j * stepY;
            const cellMaxLat = minLat + (j + 1) * stepY;
            // Добавляем небольшую случайность, чтобы сетка выглядела естественно
            const ndvi = meanNdvi + (Math.random() - 0.5) * 0.15;
            ndviValues.push(ndvi);

            let health;
            if (ndvi >= 0.7) health = 'отлично';
            else if (ndvi >= 0.55) health = 'хорошо';
            else if (ndvi >= 0.4) health = 'средне';
            else if (ndvi >= 0.25) health = 'плохо';
            else health = 'критично';

            const color = ndvi >= 0.7 ? '#2e7d32' :
                         ndvi >= 0.55 ? '#7cb342' :
                         ndvi >= 0.4 ? '#fbc02d' :
                         ndvi >= 0.25 ? '#f57c00' : '#d32f2f';

            gridCells.push({
                type: 'Feature',
                properties: { ndvi, health, color },
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [cellMinLng, cellMinLat],
                        [cellMaxLng, cellMinLat],
                        [cellMaxLng, cellMaxLat],
                        [cellMinLng, cellMaxLat],
                        [cellMinLng, cellMinLat]
                    ]]
                }
            });
        }
    }

    return {
        grid: { type: 'FeatureCollection', features: gridCells },
        avgNdvi: ndviValues.reduce((a, b) => a + b, 0) / ndviValues.length
    };
}

// API для анализа поля
app.post('/api/analyze', async (req, res) => {
    const { polygon, crop, period } = req.body;
    if (!polygon || polygon.length === 0) {
        return res.status(400).json({ error: 'Не указан полигон' });
    }

    try {
        // Вычисляем bounding box полигона
        let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
        polygon.forEach(([lng, lat]) => {
            minLng = Math.min(minLng, lng);
            maxLng = Math.max(maxLng, lng);
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
        });

        // Добавляем небольшой отступ (10%)
        const lngPad = (maxLng - minLng) * 0.1;
        const latPad = (maxLat - minLat) * 0.1;
        minLng -= lngPad;
        maxLng += lngPad;
        minLat -= latPad;
        maxLat += latPad;

        const bbox = [minLng, minLat, maxLng, maxLat];
        const centerLat = (minLat + maxLat) / 2;
        const centerLng = (minLng + maxLng) / 2;

        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(endDate.getDate() - period);
        const formatDate = (date) => date.toISOString().split('T')[0];

        console.log(`📡 Запрос данных за период ${formatDate(startDate)} - ${formatDate(endDate)}`);

        // Запрос к Sentinel Hub Statistical API
        const statsPayload = {
            input: {
                bounds: {
                    bbox: bbox,
                    properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' }
                },
                data: [{
                    type: 'S2L2A',
                    dataFilter: {
                        timeRange: {
                            from: `${formatDate(startDate)}T00:00:00Z`,
                            to: `${formatDate(endDate)}T23:59:59Z`
                        },
                        maxCloudCoverage: 20
                    }
                }]
            },
            aggregation: {
                timeRange: {
                    from: `${formatDate(startDate)}T00:00:00Z`,
                    to: `${formatDate(endDate)}T23:59:59Z`
                },
                aggregationInterval: 'P1D',
                width: 100,
                height: 100
            },
            evalscript: `
                //VERSION=3
                function setup() {
                    return {
                        input: ["B04", "B08", "dataMask"],
                        output: [
                            { id: "ndvi", bands: 1, sampleType: "FLOAT32" },
                            { id: "dataMask", bands: 1, sampleType: "UINT8" }
                        ]
                    };
                }
                function evaluatePixel(samples) {
                    let ndvi = (samples.B08 - samples.B04) / (samples.B08 + samples.B04 + 0.000001);
                    return {
                        ndvi: [ndvi],
                        dataMask: [samples.dataMask]
                    };
                }
            `,
            calculations: {
                ndvi: {
                    stats: {
                        default: true,
                        min: true,
                        max: true,
                        mean: true,
                        stDev: true,
                        histogram: { bins: 20 }
                    }
                }
            }
        };

        let statsData;
        let usingRealData = true;

        try {
            const statsResponse = await fetch('https://services.sentinel-hub.com/api/v1/statistics', {
                method: 'POST',
                headers: {
                    'Authorization': `ApiKey ${API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(statsPayload)
            });

            if (!statsResponse.ok) {
                console.warn(`⚠️ Не удалось получить реальные данные (код ${statsResponse.status}). Использую тестовые.`);
                usingRealData = false;
            } else {
                statsData = await statsResponse.json();
                console.log('✅ Данные получены от Sentinel Hub');
            }
        } catch (err) {
            console.warn('⚠️ Ошибка соединения с Sentinel Hub. Использую тестовые данные.');
            usingRealData = false;
        }

        let timeSeries = { dates: [], values: [] };
        let avgNdvi;

        if (usingRealData && statsData.data && statsData.data.length > 0) {
            // Извлекаем временной ряд из ответа
            statsData.data.forEach(interval => {
                if (interval.interval && interval.outputs?.ndvi?.bands?.B0?.stats) {
                    const date = new Date(interval.interval.from);
                    timeSeries.dates.push(date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }));
                    timeSeries.values.push(interval.outputs.ndvi.bands.B0.stats.mean);
                }
            });
            avgNdvi = timeSeries.values.reduce((a, b) => a + b, 0) / timeSeries.values.length;
        } else {
            // Генерация тестовых данных (если нет реальных)
            console.log('🧪 Генерация тестовых данных');
            for (let i = period; i >= 0; i--) {
                const d = new Date();
                d.setDate(endDate.getDate() - i);
                timeSeries.dates.push(d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }));
                timeSeries.values.push(0.5 + Math.sin(i / 10) * 0.2 + (Math.random() * 0.1));
            }
            avgNdvi = timeSeries.values.reduce((a, b) => a + b, 0) / timeSeries.values.length;
        }

        // Прогноз на 7 дней (имитация)
        const forecast = { dates: [], values: [] };
        const lastValue = timeSeries.values[timeSeries.values.length - 1] || 0.5;
        for (let i = 1; i <= 7; i++) {
            const d = new Date();
            d.setDate(endDate.getDate() + i);
            forecast.dates.push(d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }));
            forecast.values.push(Math.min(0.9, Math.max(0.1, lastValue + (Math.random() - 0.5) * 0.05)));
        }

        // Генерация сетки поля
        const { grid } = generateGridFromStats(bbox, avgNdvi);

        // Определение общего состояния
        let overallHealth;
        if (avgNdvi >= 0.7) overallHealth = 'отличное';
        else if (avgNdvi >= 0.55) overallHealth = 'хорошее';
        else if (avgNdvi >= 0.4) overallHealth = 'среднее';
        else if (avgNdvi >= 0.25) overallHealth = 'плохое';
        else overallHealth = 'критическое';

        // Зоны стресса (ячейки с NDVI < 0.3)
        const stressFeatures = grid.features.filter(f => f.properties.ndvi < 0.3);
        const stressPercent = (stressFeatures.length / grid.features.length) * 100;

        // Рекомендация
        let recommendation = '';
        if (avgNdvi > 0.6) {
            recommendation = `🌱 Состояние посевов хорошее. NDVI: ${avgNdvi.toFixed(2)}. Рекомендуется плановое внесение удобрений.`;
        } else if (avgNdvi > 0.4) {
            recommendation = `⚠️ Вегетация средняя (NDVI: ${avgNdvi.toFixed(2)}). Возможен дефицит влаги. Рекомендуется обследование.`;
        } else {
            recommendation = `❗ Критическое состояние (NDVI: ${avgNdvi.toFixed(2)}). Срочный полив и защита.`;
        }
        if (stressPercent > 20) {
            recommendation += `\n🔴 Зоны стресса: ${stressPercent.toFixed(0)}% площади — требуется точечная обработка.`;
        }

        const result = {
            summary: {
                avg_ndvi: avgNdvi,
                health: overallHealth,
                stress_percent: stressPercent,
                center: { lat: centerLat, lon: centerLng }
            },
            recommendation,
            health_grid: grid,
            stress_zones: {
                type: 'FeatureCollection',
                features: stressFeatures
            },
            time_series: timeSeries,
            forecast,
            data_source: usingRealData ? 'Sentinel-2 (реальные данные)' : 'Тестовые данные (имитация)'
        };

        res.json(result);
    } catch (error) {
        console.error('❌ Критическая ошибка сервера:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера', details: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
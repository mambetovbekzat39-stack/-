require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const GeoTIFF = require('geotiff');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== ПРОВЕРКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ ==========
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ Ошибка: CLIENT_ID и CLIENT_SECRET должны быть заданы в .env');
    process.exit(1);
}

// Кэширование токена
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiry - 300000) {
        return cachedToken;
    }

    const tokenUrl = 'https://services.sentinel-hub.com/oauth/token';
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);

    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Не удалось получить токен: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    cachedToken = data.access_token;
    tokenExpiry = Date.now() + data.expires_in * 1000;
    return cachedToken;
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

/**
 * Разбивает массив 100x100 на 3x3 блока и возвращает средние значения для каждого блока.
 */
function aggregateTo3x3(ndviArray) {
    const blockSize = 100 / 3; // 33.33, нецелое, поэтому используем округление границ
    const result = Array(3).fill().map(() => Array(3).fill(0));

    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            // Определяем границы блока в пикселях
            const xStart = Math.floor(i * blockSize);
            const xEnd = Math.floor((i + 1) * blockSize);
            const yStart = Math.floor(j * blockSize);
            const yEnd = Math.floor((j + 1) * blockSize);

            let sum = 0;
            let count = 0;
            for (let x = xStart; x < xEnd; x++) {
                for (let y = yStart; y < yEnd; y++) {
                    if (x < 100 && y < 100 && !isNaN(ndviArray[y][x])) {
                        sum += ndviArray[y][x];
                        count++;
                    }
                }
            }
            result[j][i] = count > 0 ? sum / count : 0; // Индексы: j - lat, i - lng
        }
    }
    return result;
}

/**
 * Генерирует GeoJSON FeatureCollection для сетки 3×3 на основе матрицы значений.
 */
function generateGridFromMatrix(bbox, matrix) {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const stepX = (maxLng - minLng) / 3;
    const stepY = (maxLat - minLat) / 3;

    const gridCells = [];
    const ndviValues = [];

    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            const ndvi = matrix[j][i]; // j - lat, i - lng
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

            const cellMinLng = minLng + i * stepX;
            const cellMaxLng = minLng + (i + 1) * stepX;
            const cellMinLat = minLat + j * stepY;
            const cellMaxLat = minLat + (j + 1) * stepY;

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

    const avgNdvi = ndviValues.reduce((a, b) => a + b, 0) / ndviValues.length;

    return {
        grid: { type: 'FeatureCollection', features: gridCells },
        avgNdvi
    };
}

/**
 * Простой линейный прогноз на 7 дней по последним точкам временного ряда.
 */
function linearForecast(values, days = 7) {
    if (values.length < 2) return Array(days).fill(values[0] || 0.5);

    const n = values.length;
    const indices = Array.from({ length: n }, (_, i) => i);
    const sumX = indices.reduce((a, b) => a + b, 0);
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = indices.reduce((a, i) => a + i * values[i], 0);
    const sumX2 = indices.reduce((a, i) => a + i * i, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    const forecast = [];
    for (let i = 1; i <= days; i++) {
        let val = intercept + slope * (n - 1 + i);
        val = Math.min(0.9, Math.max(0.1, val));
        forecast.push(val);
    }
    return forecast;
}

// ========== ОСНОВНОЙ ОБРАБОТЧИК ==========
app.post('/api/analyze', async (req, res) => {
    const { polygon, crop, period } = req.body;
    if (!polygon || polygon.length < 3) {
        return res.status(400).json({ error: 'Не указан или некорректен полигон' });
    }

    try {
        // --- Вычисление bbox ---
        let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
        polygon.forEach(([lng, lat]) => {
            minLng = Math.min(minLng, lng);
            maxLng = Math.max(maxLng, lng);
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
        });

        const lngPad = (maxLng - minLng) * 0.1;
        const latPad = (maxLat - minLat) * 0.1;
        minLng -= lngPad;
        maxLng += lngPad;
        minLat -= latPad;
        maxLat += latPad;

        const bbox = [minLng, minLat, maxLng, maxLat];
        const centerLat = (minLat + maxLat) / 2;
        const centerLng = (minLng + maxLng) / 2;

        // --- Подготовка дат ---
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(endDate.getDate() - period);
        const formatDate = (date) => date.toISOString().split('T')[0];

        console.log(`\n📡 Запрос данных за период ${formatDate(startDate)} - ${formatDate(endDate)}`);

        // --- Получение токена ---
        const accessToken = await getAccessToken();

        // --- Формирование запроса к Process API (реальный NDVI) ---
        const evalscript = `
            //VERSION=3
            function setup() {
                return {
                    input: ["B04", "B08"],
                    output: { bands: 1, sampleType: "FLOAT32" }
                };
            }
            function evaluatePixel(sample) {
                let ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04 + 0.000001);
                return [ndvi];
            }
        `;

        const processPayload = {
            input: {
                bounds: {
                    bbox: bbox,
                    properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" }
                },
                data: [{
                    type: "sentinel-2-l2a",
                    dataFilter: {
                        timeRange: {
                            from: `${formatDate(startDate)}T00:00:00Z`,
                            to: `${formatDate(endDate)}T23:59:59Z`
                        },
                        maxCloudCoverage: 20
                    }
                }]
            },
            output: {
                width: 100,
                height: 100,
                responses: [{
                    identifier: "default",
                    format: { type: "image/tiff" }
                }]
            },
            evalscript: evalscript
        };

        let ndviMatrix = null;
        let usingRealData = true;
        let avgNdvi, stdDev;

        try {
            const processResponse = await fetch('https://services.sentinel-hub.com/api/v1/process', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(processPayload)
            });

            if (!processResponse.ok) {
                const errorText = await processResponse.text();
                console.warn(`⚠️ Не удалось получить реальные данные (код ${processResponse.status}): ${errorText}`);
                usingRealData = false;
            } else {
                console.log('✅ Данные получены от Sentinel Hub (Process API)');
                const arrayBuffer = await processResponse.arrayBuffer();
                const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
                const image = await tiff.getImage();
                const rasters = await image.readRasters();
                // Предполагаем один канал
                const width = image.getWidth();
                const height = image.getHeight();
                const data = rasters[0]; // Float32Array

                // Преобразуем в 2D массив
                ndviMatrix = [];
                for (let y = 0; y < height; y++) {
                    const row = [];
                    for (let x = 0; x < width; x++) {
                        let val = data[y * width + x];
                        // Заменяем no-data (обычно -9999) на NaN
                        if (val < -1 || val > 1) val = NaN;
                        row.push(val);
                    }
                    ndviMatrix.push(row);
                }

                // Вычисляем общее среднее и стандартное отклонение
                const validValues = ndviMatrix.flat().filter(v => !isNaN(v));
                if (validValues.length === 0) {
                    throw new Error('Нет валидных пикселей (возможно, все закрыты облаками)');
                }
                avgNdvi = validValues.reduce((a, b) => a + b, 0) / validValues.length;
                const mean = avgNdvi;
                const squaredDiffs = validValues.map(v => Math.pow(v - mean, 2));
                stdDev = Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / validValues.length);

                console.log(`📊 Средний NDVI за период: ${avgNdvi.toFixed(3)}, ст.отклонение: ${stdDev.toFixed(3)}`);
            }
        } catch (err) {
            console.warn('⚠️ Ошибка при запросе Process API. Использую тестовые данные.', err.message);
            usingRealData = false;
        }

        // --- Генерация временного ряда (тестового, но с реальным средним) ---
        let timeSeries = { dates: [], values: [] };
        if (usingRealData && avgNdvi !== undefined) {
            // Создаём тестовый временной ряд, колеблющийся вокруг реального среднего
            for (let i = period; i >= 0; i--) {
                const d = new Date();
                d.setDate(endDate.getDate() - i);
                timeSeries.dates.push(d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }));
                // Генерируем значение с небольшими колебаниями
                let val = avgNdvi + Math.sin(i / 5) * 0.05 + (Math.random() * 0.02 - 0.01);
                val = Math.min(0.9, Math.max(0.1, val));
                timeSeries.values.push(val);
            }
        } else {
            // Полностью тестовые данные
            console.log('🧪 Генерация тестовых данных');
            for (let i = period; i >= 0; i--) {
                const d = new Date();
                d.setDate(endDate.getDate() - i);
                timeSeries.dates.push(d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }));
                timeSeries.values.push(0.5 + Math.sin(i / 10) * 0.2 + (Math.random() * 0.1));
            }
            avgNdvi = timeSeries.values.reduce((a, b) => a + b, 0) / timeSeries.values.length;
            stdDev = 0.15;
        }

        // --- Прогноз ---
        const forecastValues = linearForecast(timeSeries.values.slice(-5), 7);
        const forecast = {
            dates: Array.from({ length: 7 }, (_, i) => {
                const d = new Date();
                d.setDate(endDate.getDate() + i + 1);
                return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
            }),
            values: forecastValues
        };

        // --- Сетка 3×3 на основе реальных данных (если есть) ---
        let grid;
        if (usingRealData && ndviMatrix) {
            // Агрегируем 100x100 в 3x3
            const matrix3x3 = aggregateTo3x3(ndviMatrix);
            const gridResult = generateGridFromMatrix(bbox, matrix3x3);
            grid = gridResult.grid;
            // Пересчитываем среднее по сетке (оно может немного отличаться от общего среднего)
            avgNdvi = gridResult.avgNdvi;
        } else {
            // Генерация тестовой сетки на основе среднего и ст. отклонения
            const { grid: testGrid } = generateGridFromMatrix(bbox, [
                [avgNdvi + 0.1, avgNdvi - 0.05, avgNdvi + 0.02],
                [avgNdvi - 0.03, avgNdvi + 0.07, avgNdvi - 0.08],
                [avgNdvi + 0.04, avgNdvi - 0.02, avgNdvi + 0.05]
            ]);
            grid = testGrid;
        }

        // --- Определение общего состояния ---
        let overallHealth;
        if (avgNdvi >= 0.7) overallHealth = 'отличное';
        else if (avgNdvi >= 0.55) overallHealth = 'хорошее';
        else if (avgNdvi >= 0.4) overallHealth = 'среднее';
        else if (avgNdvi >= 0.25) overallHealth = 'плохое';
        else overallHealth = 'критическое';

        const stressFeatures = grid.features.filter(f => f.properties.ndvi < 0.3);
        const stressPercent = (stressFeatures.length / grid.features.length) * 100;

        // --- Рекомендация ---
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

        // --- Итоговый ответ ---
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
                features: grid.features.filter(f => f.properties.ndvi < 0.3)
            },
            time_series: timeSeries,
            forecast,
            data_source: usingRealData ? 'Sentinel-2 L2A (реальные данные, Process API)' : 'Тестовые данные (имитация)'
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
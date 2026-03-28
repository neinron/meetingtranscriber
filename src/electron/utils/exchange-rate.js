const { getCachedExchangeRate, saveCachedExchangeRate } = require("./settings");

const ECB_DAILY_RATES_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

const fetchLatestEcbExchangeRate = async () => {
  const response = await fetch(ECB_DAILY_RATES_URL, {
    headers: {
      Accept: "application/xml,text/xml",
    },
  });

  if (!response.ok) {
    throw new Error(`ECB exchange rate request failed: ${response.status}`);
  }

  const xml = await response.text();
  const dateMatch = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/i);
  const usdMatch = xml.match(/currency=['"]USD['"]\s+rate=['"]([0-9.]+)['"]/i);
  const usdPerEur = Number(usdMatch?.[1]);

  if (!dateMatch || !Number.isFinite(usdPerEur) || usdPerEur <= 0) {
    throw new Error("ECB exchange rate response did not include a USD reference rate.");
  }

  const rate = {
    eurPerUsd: 1 / usdPerEur,
    usdPerEur,
    referenceDate: dateMatch[1],
    fetchedAt: new Date().toISOString(),
    source: "ecb",
  };

  saveCachedExchangeRate(rate);
  return rate;
};

const getExchangeRate = async () => {
  try {
    return await fetchLatestEcbExchangeRate();
  } catch (error) {
    const cached = getCachedExchangeRate();
    if (cached) {
      return {
        ...cached,
        source: "cache",
        warning: error.message,
      };
    }

    throw error;
  }
};

module.exports = {
  getExchangeRate,
};

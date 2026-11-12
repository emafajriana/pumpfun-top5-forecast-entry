# Pump.fun Top-5 Forecaster

This Node.js 22 entry weights historical top-40 marks by recency, venue, rank,
and cap growth. It turns the resulting coin scores into horizon-scaled rank
probabilities, then forecasts cap-size bins with a horizon-scaled normal kernel.

Run with `MAKEFUN_INPUT_DIR` pointing to the directory containing `history.ndjson`
and `task.json`, and `MAKEFUN_OUTPUT_DIR` pointing to the output directory.
The program uses only Node's standard library and writes `forecast.json`.

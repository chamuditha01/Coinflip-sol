const webpack = require('webpack');

module.exports = function override(config) {
    // 1. Polyfills for Solana (Crypto, Buffer, etc.)
    const fallback = config.resolve.fallback || {};
    Object.assign(fallback, {
        "crypto": require.resolve("crypto-browserify"),
        "stream": require.resolve("stream-browserify"),
        "vm": require.resolve("vm-browserify"),
        "process": require.resolve("process/browser"),
    });
    config.resolve.fallback = fallback;

    // 2. THE FIX FOR BS58 ERROR: Remove source-map-loader for all dependencies
    config.module.rules = config.module.rules.map(rule => {
        if (rule.use && rule.use.some(u => u.loader && u.loader.includes('source-map-loader'))) {
            return {
                ...rule,
                exclude: [/node_modules/],
            };
        }
        return rule;
    });

    // 3. Global Variable Injection
    config.plugins = (config.plugins || []).concat([
        new webpack.ProvidePlugin({
            process: 'process/browser.js',
            Buffer: ['buffer', 'Buffer'],
        }),
    ]);

    // 4. Ignore the warnings in the console
    config.ignoreWarnings = [/Failed to parse source map/];

    return config;
};
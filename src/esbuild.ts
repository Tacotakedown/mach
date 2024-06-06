/*
 * SPDX-FileCopyrightText: 2022 Synaptic Simulations and its contributors
 * SPDX-License-Identifier: MIT
 */

import path from "node:path";
import chokidar from "chokidar";
import esbuild, { type BuildIncremental, type BuildOptions } from "esbuild";
import type { BuildLogger } from "./logger";
import { includeCSS, resolve, writeMetafile, writePackageSources } from "./plugins";
import { type BuildResultWithMeta, ESBUILD_ERRORS, type Instrument, type MachConfig } from "./types";

async function build(
    config: MachConfig,
    instrument: Instrument,
    logger: BuildLogger,
    module = false,
): Promise<BuildResultWithMeta> {
    const envVars = Object.fromEntries(
        Object.entries(process.env)
            .filter(([key]) => /^[A-Za-z_]*$/.test(key))
            .map(([key, value]) => [
                `process.env.${key}`,
                value?.toLowerCase() === "true" || value?.toLowerCase() === "false"
                    ? value.toLowerCase()
                    : `"${value?.replace(/\\/g, "/").replace(/"/g, '\\"') ?? ""}"`,
            ]),
    );

    const buildOptions: BuildOptions & { incremental: true; metafile: true } = {
        absWorkingDir: process.cwd(),
        entryPoints: [instrument.index],
        outfile: path.join(process.env.BUNDLES_DIR, instrument.name, module ? "/module/module.mjs" : "bundle.js"),
        external: ["/Images/*", "/Fonts/*"],
        incremental: true,
        metafile: true,
        bundle: true,
        target: "es2017",
        format: module ? "esm" : "iife",
        logLevel: "silent",
        logOverride: process.env.WARNINGS_ERROR === "true" ? ESBUILD_ERRORS : undefined,
        sourcemap: process.env.OUTPUT_SOURCEMAPS === "true" ? "inline" : undefined,
        minify: process.env.MINIFY_BUNDLES === "true",
        plugins: [...(config.plugins ?? []), ...(instrument.plugins ?? [])],
        define: {
            ...envVars,
            "process.env.MODULE": module.toString(),
        },
    };

    if (process.env.OUTPUT_METAFILE) {
        buildOptions.plugins?.push(writeMetafile);
    }

    // Resolve submodules to their bundles
    if (instrument.modules) {
        buildOptions.plugins?.push(
            resolve(
                Object.fromEntries(
                    instrument.modules.map((mod) => [
                        mod.resolve,
                        path.join(process.env.BUNDLES_DIR, mod.name, "/module/module.mjs"),
                    ]),
                ),
            ),
            includeCSS(
                instrument.modules.map((mod) => path.join(process.env.BUNDLES_DIR, mod.name, "/module/module.css")),
            ),
        );
    }

    if (instrument.simulatorPackage && process.env.SKIP_SIM_PACKAGE !== "true" && !module) {
        buildOptions.plugins?.push(writePackageSources(logger, instrument));
    }

    return esbuild.build(buildOptions);
}

export async function buildInstrument(
    config: MachConfig,
    instrument: Instrument,
    logger: BuildLogger,
    module = false,
): Promise<BuildResultWithMeta> {
    let moduleResults: BuildResultWithMeta[] = [];

    // Recursively build included submodules
    if (instrument.modules) {
        moduleResults = await Promise.all(
            instrument.modules.map((module) => buildInstrument(config, module, logger, true)),
        );

        // Skip main instrument bundling if the submodule fails.
        for (const result of moduleResults) {
            if (result.errors.length > 0) {
                return result;
            }
        }

        for (const result of moduleResults) {
            result.rebuild?.dispose();
        }
    }

    const startTime = performance.now();
    const { success, result } = await build(config, instrument, logger, module)
        .then((result: BuildResultWithMeta) => ({
            success: true,
            result,
        }))
        .catch((result: BuildResultWithMeta) => {
            logger.buildFailed(result.errors);
            return {
                success: false,
                result,
            };
        });
    const endTime = performance.now();

    if (success) {
        logger.buildComplete(instrument.name, endTime - startTime, result);
    }

    return result;
}

function resolveFilename(input: string): string {
    const cwdIndex = input.indexOf(process.cwd());
    return path.resolve(cwdIndex >= 0 ? input.slice(cwdIndex) : input);
}

export async function watchInstrument(
    config: MachConfig,
    instrument: Instrument,
    logger: BuildLogger,
    module = false,
): Promise<BuildResultWithMeta> {
    // Recursively watch included submodules
    if (instrument.modules) {
        await Promise.all(instrument.modules.map((module) => watchInstrument(config, module, logger, true)));
    }

    let result = await buildInstrument(config, instrument, logger, module);

    // Chokidar needs a list of files to watch, but we don't get the metafile on a failed build.
    if (result.errors.length > 0) {
        return result;
    }

    const builtFiles = Object.keys(result.metafile.inputs).map(resolveFilename);
    const watcher = chokidar.watch(builtFiles);
    watcher.on("change", async (filePath) => {
        logger.changeDetected(filePath);

        const startTime = performance.now();
        const { success, res } = await result
            .rebuild()
            .then((res: BuildIncremental) => ({
                success: true,
                res: res as BuildResultWithMeta,
            }))
            .catch((res: BuildIncremental) => {
                logger.buildFailed(res.errors);
                return {
                    success: false,
                    res: res as BuildResultWithMeta,
                };
            });
        const endTime = performance.now();

        if (success) {
            result = res as BuildResultWithMeta;

            logger.buildComplete(instrument.name, endTime - startTime, result);

            const watchedFiles = watcher.getWatched();
            const bundledFiles = Object.keys(result.metafile.inputs).map(resolveFilename);

            // Watch files that have been added to the bundle
            for (const file of bundledFiles) {
                if (!watchedFiles[path.dirname(file)]?.includes(path.basename(file))) {
                    watcher.add(file);
                }
            }
            // Unwatch files that are no longer included in the bundle
            for (const [dir, files] of Object.entries(watchedFiles)) {
                for (const file of files) {
                    const filePath = path.join(dir, file);
                    if (!bundledFiles.includes(filePath)) {
                        watcher.unwatch(filePath);
                    }
                }
            }
        }
    });

    return result;
}

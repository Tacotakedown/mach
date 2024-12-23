/*
 * SPDX-FileCopyrightText: 2022 Synaptic Simulations and its contributors
 * SPDX-License-Identifier: MIT
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "esbuild";
import { renderFile } from "template-file";

import type { Instrument, MachArgs } from "./types";

/**
 * Override module resolution of specified imports.
 */
export const resolve = (options: { [module: string]: string }): Plugin => ({
    name: "resolve",
    setup(build) {
        build.onResolve({ filter: new RegExp(`^(${Object.keys(options).join("|")})$`) }, (args) => ({
            path: options[args.path],
        }));
    },
});

/**
 * Include specified CSS bundles in main bundle.
 */
export const includeCSS = (modules: string[]): Plugin => ({
    name: "includeCSS",
    setup(build) {
        build.onEnd(() => {
            const cssPath = path.join(path.dirname(build.initialOptions.outfile!), "bundle.css");
            modules.map(async (mod) => {
                const css = await fs.readFile(mod);
                await fs.appendFile(cssPath, css);
            });
        });
    },
});

/**
 * Write `build_meta.json` files containing build data into the bundle directory.
 */
export const writeMetafile: Plugin = {
    name: "writeMetafile",
    setup(build) {
        build.onEnd((result) => {
            if (result.errors.length === 0) {
                fs.writeFile(
                    path.join(path.dirname(build.initialOptions.outfile!), "build_meta.json"),
                    JSON.stringify(result.metafile),
                );
            }
        });
    },
};

/**
 * Export simulator packages to `PackageSources` directory
 */
export const writePackageSources = (args: MachArgs, instrument: Instrument): Plugin => ({
    name: "writePackageSources",
    setup(build) {
        build.onEnd(async (result) => {
            if (instrument.simulatorPackage && result.errors.length === 0) {
                const jsBundlePath = path.join(path.dirname(build.initialOptions.outfile!), "bundle.js");
                const cssBundlePath = path.join(path.dirname(build.initialOptions.outfile!), "bundle.css");

                const js = await fs.readFile(jsBundlePath, { encoding: "utf-8" });
                const css = await fs.readFile(cssBundlePath, { encoding: "utf-8" });

                const htmlUiPath = path.join(process.cwd(), args.config.packageDir, "html_ui");
                const packageTarget = path.join(
                    htmlUiPath,
                    "Pages/VCockpit/Instruments",
                    args.config.packageName,
                    instrument.name,
                );
                await fs.mkdir(packageTarget, { recursive: true });

                const fileName = instrument.simulatorPackage.fileName ?? "instrument";
                const templateId = instrument.simulatorPackage.templateId ?? instrument.name;

                const cssPath = path.join(packageTarget, `${fileName}.css`);
                const jsPath = path.join(packageTarget, `${fileName}.js`);
                const instrumentPath =
                    instrument.simulatorPackage.type === "react" || instrument.simulatorPackage.type === "solid"
                        ? path.join(packageTarget, `${fileName}.index.js`)
                        : jsPath;

                const templateParams = {
                    templateId,
                    instrumentName: `${args.config.packageName.toLowerCase()}-${templateId.toLowerCase()}`,
                    mountElementId:
                        instrument.simulatorPackage.type === "react"
                            ? "MSFS_REACT_MOUNT"
                            : instrument.simulatorPackage.type === "solid"
                              ? "MSFS_SOLID_MOUNT"
                              : instrument.simulatorPackage.mountElementId,
                    imports: instrument.simulatorPackage.imports ?? [],
                    cssPath: cssPath.replace(htmlUiPath, "").replace(/\\/g, "/"),
                    jsPath: jsPath.replace(htmlUiPath, "").replace(/\\/g, "/"),
                    instrumentPath: instrumentPath.replace(htmlUiPath, "").replace(/\\/g, "/"),
                };

                await fs.writeFile(cssPath, css);
                await fs.writeFile(jsPath, js);

                if (instrument.simulatorPackage.type === "react" || instrument.simulatorPackage.type === "solid") {
                    await fs.writeFile(
                        instrumentPath,
                        await renderFile(path.join(__dirname, "./templates/instrument.cjs"), templateParams),
                    );
                }

                await fs.writeFile(
                    path.join(packageTarget, `${fileName}.html`),
                    await renderFile(path.join(__dirname, "./templates/index.html"), templateParams),
                );
            }
        });
    },
});

#!/usr/bin/env node

import {
    AllTypeScriptVersion,
    isTypeScriptVersion,
    parseTypeScriptVersionLine,
    TypeScriptVersion,
} from "definitelytyped-header-parser";
import { readdir, readFile, stat } from "fs-extra";
import { basename, dirname, join as joinPaths, resolve } from "path";

import { checkPackageJson, checkTsconfig } from "./checks";
import { cleanInstalls, installAll, installNext } from "./installer";
import { checkTslintJson, lint, TsVersion } from "./lint";
import { assertDefined, last, mapDefinedAsync, withoutPrefix } from "./util";

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    let dirPath = process.cwd();
    let onlyTestTsNext = false;
    let expectOnly = false;
    let shouldListen = false;
    let lookingForTsLocal = false;
    let tsLocal: string | undefined;

    for (const arg of args) {
        if (lookingForTsLocal) {
            if (arg.startsWith("--")) {
                throw new Error("Looking for local path for TS, but got " + arg);
            }
            tsLocal = resolve(arg);
            lookingForTsLocal = false;
            continue;
        }
        switch (arg) {
            case "--installAll":
                console.log("Cleaning old installs and installing for all TypeScript versions...");
                console.log("Working...");
                await cleanInstalls();
                await installAll();
                return;
            case "--localTs":
                lookingForTsLocal = true;
                break;
            case "--version":
                console.log(require("../package.json").version);
                return;
            case "--expectOnly":
                expectOnly = true;
                break;
            case "--onlyTestTsNext":
                onlyTestTsNext = true;
                break;
            // Only for use by types-publisher.
            // Listens for { path, onlyTestTsNext } messages and ouputs { path, status }.
            case "--listen":
                shouldListen = true;
                break;
            default:
                if (arg.startsWith("--")) {
                    console.error(`Unknown option '${arg}'`);
                    usage();
                    process.exit(1);
                }

                const path = arg.indexOf("@") === 0 && arg.indexOf("/") !== -1
                    // we have a scoped module, e.g. @bla/foo
                    // which should be converted to   bla__foo
                    ? arg.substr(1).replace("/", "__")
                    : arg;
                dirPath = joinPaths(dirPath, path);
        }
    }
    if (lookingForTsLocal) {
        throw new Error("Path for --localTs was not provided.");
    }

    if (shouldListen) {
        listen(dirPath, tsLocal);
        // Do this *after* to ensure messages sent during installation aren't dropped.
        if (!tsLocal) {
            await installAll();
        }
    } else {
        if (!tsLocal) {
            if (onlyTestTsNext) {
                await installNext();
            } else {
                await installAll();
            }
        }
        await runTests(dirPath, onlyTestTsNext, expectOnly, tsLocal);
    }
}

function usage(): void {
    console.error("Usage: dtslint [--version] [--installAll] [--onlyTestTsNext] [--expectOnly] [--localTs path]");
    console.error("Args:");
    console.error("  --version        Print version and exit.");
    console.error("  --installAll     Cleans and installs all TypeScript versions.");
    console.error("  --expectOnly     Run only the ExpectType lint rule.");
    console.error("  --onlyTestTsNext Only run with `typescript@next`, not with the minimum version.");
    console.error("  --localTs path   Run with *path* as the latest version of TS.");
    console.error("");
    console.error("onlyTestTsNext and localTs are (1) mutually exclusive and (2) test a single version of TS");
}

function listen(dirPath: string, tsLocal: string | undefined): void {
    process.on("message", (message: {}) => {
        const { path, onlyTestTsNext, expectOnly } = message as { path: string, onlyTestTsNext: boolean, expectOnly?: boolean };
        runTests(joinPaths(dirPath, path), onlyTestTsNext, !!expectOnly, tsLocal)
            .catch(e => e.stack)
            .then(maybeError => {
                process.send!({ path, status: maybeError === undefined ? "OK" : maybeError });
            })
            .catch(e => console.error(e.stack));
    });
}

async function runTests(
    dirPath: string,
    onlyTestTsNext: boolean,
    expectOnly: boolean,
    tsLocal: string | undefined,
): Promise<void> {
    const isOlderVersion = /^v\d+$/.test(basename(dirPath));

    const indexText = await readFile(joinPaths(dirPath, "index.d.ts"), "utf-8");
    // If this *is* on DefinitelyTyped, types-publisher will fail if it can't parse the header.
    const dt = indexText.includes("// Type definitions for");
    if (dt) {
        // Someone may have copied text from DefinitelyTyped to their type definition and included a header,
        // so assert that we're really on DefinitelyTyped.
        assertPathIsInDefinitelyTyped(dirPath);
        assertPathIsNotBanned(dirPath);
    }

    const typesVersions = await mapDefinedAsync(await readdir(dirPath), async name => {
        if (name === "tsconfig.json" || name === "tslint.json" || name === "tsutils") { return undefined; }
        const version = withoutPrefix(name, "ts");
        if (version === undefined || !(await stat(joinPaths(dirPath, name))).isDirectory()) { return undefined; }

        if (!isTypeScriptVersion(version)) {
            throw new Error(`There is an entry named ${name}, but ${version} is not a valid TypeScript version.`);
        }
        if (!TypeScriptVersion.isRedirectable(version)) {
            throw new Error(`At ${dirPath}/${name}: TypeScript version directories only available starting with ts3.1.`);
        }
        return version;
    });

    if (dt) {
        await checkPackageJson(dirPath, typesVersions);
    }

    if (onlyTestTsNext || tsLocal) {
        const tsVersion = tsLocal ? "local" : "next";
        if (typesVersions.length === 0) {
            await testTypesVersion(dirPath, tsVersion, tsVersion, isOlderVersion, dt, indexText, expectOnly, tsLocal);
        } else {
            const latestTypesVersion = last(typesVersions);
            const versionPath = joinPaths(dirPath, `ts${latestTypesVersion}`);
            const versionIndexText = await readFile(joinPaths(versionPath, "index.d.ts"), "utf-8");
            await testTypesVersion(
                versionPath, tsVersion, tsVersion,
                isOlderVersion, dt, versionIndexText, expectOnly, tsLocal, /*inTypesVersionDirectory*/ true);
        }
    } else {
        await testTypesVersion(dirPath, undefined, getTsVersion(0), isOlderVersion, dt, indexText, expectOnly, undefined);
        for (let i = 0; i < typesVersions.length; i++) {
            const version = typesVersions[i];
            const versionPath = joinPaths(dirPath, `ts${version}`);
            const versionIndexText = await readFile(joinPaths(versionPath, "index.d.ts"), "utf-8");
            await testTypesVersion(
                versionPath, version, getTsVersion(i + 1), isOlderVersion, dt, versionIndexText,
                expectOnly, undefined, /*inTypesVersionDirectory*/ true);
        }

        function getTsVersion(i: number): TsVersion {
            return i === typesVersions.length ? "next" : assertDefined(TypeScriptVersion.previous(typesVersions[i]));
        }
    }
}

async function testTypesVersion(
    dirPath: string,
    lowVersion: TsVersion | undefined,
    maxVersion: TsVersion,
    isOlderVersion: boolean,
    dt: boolean,
    indexText: string,
    expectOnly: boolean,
    tsLocal: string | undefined,
    inTypesVersionDirectory?: boolean,
): Promise<void> {
    const minVersionFromComment = getTypeScriptVersionFromComment(indexText);
    if (minVersionFromComment !== undefined && inTypesVersionDirectory) {
        throw new Error(`Already in the \`ts${lowVersion}\` directory, don't need \`// TypeScript Version\`.`);
    }
    const minVersion = lowVersion
        || minVersionFromComment && TypeScriptVersion.isSupported(minVersionFromComment) && minVersionFromComment
        || TypeScriptVersion.lowest;

    await checkTslintJson(dirPath, dt);
    await checkTsconfig(dirPath, dt
        ? { relativeBaseUrl: ".." + (isOlderVersion ? "/.." : "") + (inTypesVersionDirectory ? "/.." : "") + "/" }
        : undefined);
    const err = await lint(dirPath, minVersion, maxVersion, !!inTypesVersionDirectory, expectOnly, tsLocal);
    if (err) {
        throw new Error(err);
    }
}

function assertPathIsInDefinitelyTyped(dirPath: string): void {
    const parent = dirname(dirPath);
    const types = /^v\d+$/.test(basename(dirPath)) ? dirname(parent) : parent;
    // TODO: It's not clear whether this assertion makes sense, and it's broken on Azure Pipelines
    // Re-enable it later if it makes sense.
    // const dt = dirname(types);
    // if (basename(dt) !== "DefinitelyTyped" || basename(types) !== "types") {
    if (basename(types) !== "types") {
        throw new Error("Since this type definition includes a header (a comment starting with `// Type definitions for`), "
            + "assumed this was a DefinitelyTyped package.\n"
            + "But it is not in a `DefinitelyTyped/types/xxx` directory: "
            + dirPath);
    }
}

function assertPathIsNotBanned(dirPath: string) {
    const basedir = basename(dirPath);
    if (/(^|\W)download($|\W)/.test(basedir) &&
        basedir !== "download" &&
        basedir !== "downloadjs" &&
        basedir !== "s3-download-stream") {
        // Since npm won't release their banned-words list, we'll have to manually add to this list.
        throw new Error(`${dirPath}: Contains the word 'download', which is banned by npm.`);
    }
}

function getTypeScriptVersionFromComment(text: string): AllTypeScriptVersion | undefined {
    const searchString = "// TypeScript Version: ";
    const x = text.indexOf(searchString);
    if (x === -1) {
        return undefined;
    }

    let line = text.slice(x, text.indexOf("\n", x));
    if (line.endsWith("\r")) {
        line = line.slice(0, line.length - 1);
    }
    return parseTypeScriptVersionLine(line);
}

if (!module.parent) {
    main().catch(err => {
        console.error(err.stack);
        process.exit(1);
    });
}

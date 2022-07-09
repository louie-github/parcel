// @flow strict-local

import type {FileSystem, FileOptions} from '@parcel/fs';
import type {ContentKey} from '@parcel/graph';
import type {Async, Blob, FilePath, Compressor} from '@parcel/types';

import type {RunAPI, StaticRunOpts} from '../RequestTracker';
import type {Bundle, PackagedBundleInfo, ParcelOptions} from '../types';
import type BundleGraph from '../BundleGraph';
import type {BundleInfo} from '../PackagerRunner';
import type {ConfigAndCachePath} from './ParcelConfigRequest';
import type {LoadedPlugin} from '../ParcelConfig';
import type {ProjectPath} from '../projectPath';

import {HASH_REF_PREFIX, HASH_REF_REGEX} from '../constants';
import nullthrows from 'nullthrows';
import path from 'path';
import {NamedBundle} from '../public/Bundle';
import {blobToStream, TapStream} from '@parcel/utils';
import {Readable, Transform, pipeline} from 'stream';
import {
  fromProjectPath,
  fromProjectPathRelative,
  toProjectPath,
  joinProjectPath,
  toProjectPathUnsafe,
} from '../projectPath';
import createParcelConfigRequest, {
  getCachedParcelConfig,
} from './ParcelConfigRequest';
import PluginOptions from '../public/PluginOptions';
import {PluginLogger} from '@parcel/logger';
import {
  getDevDepRequests,
  invalidateDevDeps,
  createDevDependency,
  runDevDepRequest,
} from './DevDepRequest';
import ParcelConfig from '../ParcelConfig';
import ThrowableDiagnostic, {errorToDiagnostic} from '@parcel/diagnostic';

const BOUNDARY_LENGTH = HASH_REF_PREFIX.length + 32 - 1;

type WriteBundleRequestInput = {|
  bundleGraph: BundleGraph,
  bundle: Bundle,
  info: BundleInfo,
  hashRefToNameHash: Map<string, string>,
|};

type RunInput = {|
  input: WriteBundleRequestInput,
  ...StaticRunOpts,
|};

export type WriteBundleRequest = {|
  id: ContentKey,
  +type: 'write_bundle_request',
  run: RunInput => Async<PackagedBundleInfo>,
  input: WriteBundleRequestInput,
|};

/**
 * Writes a bundle to the dist directory, replacing hash references with the final content hashes.
 */
export default function createWriteBundleRequest(
  input: WriteBundleRequestInput,
): WriteBundleRequest {
  let name = nullthrows(input.bundle.name);
  let nameHash = nullthrows(
    input.hashRefToNameHash.get(input.bundle.hashReference),
  );
  return {
    id: `${input.bundle.id}:${input.info.hash}:${nameHash}:${name}`,
    type: 'write_bundle_request',
    run,
    input,
  };
}

async function run({input, options, api}: RunInput) {
  let {bundleGraph, bundle, info, hashRefToNameHash} = input;
  let {inputFS, outputFS} = options;
  let name = nullthrows(bundle.name);
  let thisHashReference = bundle.hashReference;

  if (info.type !== bundle.type) {
    name = name.slice(0, -path.extname(name).length) + '.' + info.type;
  }

  if (name.includes(thisHashReference)) {
    let thisNameHash = nullthrows(hashRefToNameHash.get(thisHashReference));
    name = name.replace(thisHashReference, thisNameHash);
  }

  let filePath = joinProjectPath(bundle.target.distDir, name);

  // Watch the bundle and source map for deletion.
  // Also watch the dist dir because invalidateOnFileDelete does not currently
  // invalidate when a parent directory is deleted.
  // TODO: do we want to also watch for file edits?
  api.invalidateOnFileDelete(bundle.target.distDir);
  api.invalidateOnFileDelete(filePath);

  let cacheKeys = info.cacheKeys;
  let mapKey = cacheKeys.map;
  let fullPath = fromProjectPath(options.projectRoot, filePath);
  if (mapKey && bundle.env.sourceMap && !bundle.env.sourceMap.inline) {
    api.invalidateOnFileDelete(
      toProjectPath(options.projectRoot, fullPath + '.map'),
    );
  }

  let dir = path.dirname(fullPath);
  await outputFS.mkdirp(dir); // ? Got rid of dist exists, is this an expensive operation

  // Use the file mode from the entry asset as the file mode for the bundle.
  // Don't do this for browser builds, as the executable bit in particular is unnecessary.
  let publicBundle = NamedBundle.get(bundle, bundleGraph, options);
  let mainEntry = publicBundle.getMainEntry();
  let writeOptions =
    publicBundle.env.isBrowser() || !mainEntry
      ? undefined
      : {
          mode: (await inputFS.stat(mainEntry.filePath)).mode,
        };
  let content: Blob;
  if (info.isLargeBlob) {
    content = options.cache.getStream(cacheKeys.content);
  } else {
    content = await options.cache.getBlob(cacheKeys.content);
  }
  let size = 0;
  if (content instanceof Readable) {
    content = content.pipe(
      new TapStream(buf => {
        size += buf.length;
      }),
    );
  } else if (content instanceof Buffer) {
    size = content.byteLength;
  } else {
    // TODO bytelength vs char count
    size = content.length;
  }

  let configResult = nullthrows(
    await api.runRequest<null, ConfigAndCachePath>(createParcelConfigRequest()),
  );
  let config = getCachedParcelConfig(configResult, options);

  let {devDeps, invalidDevDeps} = await getDevDepRequests(api);
  invalidateDevDeps(invalidDevDeps, options, config);

  await writeFiles(
    content,
    info,
    hashRefToNameHash,
    options,
    config,
    outputFS,
    filePath,
    writeOptions,
    devDeps,
    api,
  );

  if (
    mapKey &&
    bundle.env.sourceMap &&
    !bundle.env.sourceMap.inline &&
    (await options.cache.has(mapKey))
  ) {
    await writeFiles(
      await options.cache.getBlob(mapKey),
      info,
      hashRefToNameHash,
      options,
      config,
      outputFS,
      toProjectPathUnsafe(fromProjectPathRelative(filePath) + '.map'),
      writeOptions,
      devDeps,
      api,
    );
  }

  let res = {
    filePath,
    type: info.type,
    stats: {
      size,
      time: info.time ?? 0,
    },
  };

  api.storeResult(res);
  return res;
}

async function writeFiles(
  input: Blob,
  info: BundleInfo,
  hashRefToNameHash: Map<string, string>,
  options: ParcelOptions,
  config: ParcelConfig,
  outputFS: FileSystem,
  filePath: ProjectPath,
  writeOptions: ?FileOptions,
  devDeps: Map<string, string>,
  api: RunAPI,
) {
  let compressors = await config.getCompressors(
    fromProjectPathRelative(filePath),
  );
  let fullPath = fromProjectPath(options.projectRoot, filePath);

  let inputCompressor = input;
  if (info.hashReferences.length) {
    if (input instanceof Readable) {
      inputCompressor = input.pipe(replaceStream(hashRefToNameHash));
    } else if (input instanceof Buffer) {
      inputCompressor = replaceString(
        hashRefToNameHash,
        input.toString('utf8'),
      );
    } else {
      inputCompressor = replaceString(hashRefToNameHash, input);
    }
  }

  let promises = [];
  for (let compressor of compressors) {
    promises.push(
      runCompressor(
        compressor,
        inputCompressor instanceof Readable
          ? cloneStream(inputCompressor)
          : inputCompressor,
        options,
        outputFS,
        fullPath,
        writeOptions,
        devDeps,
        api,
      ),
    );
  }

  await Promise.all(promises);
}

async function runCompressor(
  compressor: LoadedPlugin<Compressor>,
  input: Blob,
  options: ParcelOptions,
  outputFS: FileSystem,
  filePath: FilePath,
  writeOptions: ?FileOptions,
  devDeps: Map<string, string>,
  api: RunAPI,
) {
  try {
    let params = {
      contents: input,
      get stream() {
        return blobToStream(input);
      },
      options: new PluginOptions(options),
      logger: new PluginLogger({origin: compressor.name}),
    };
    let res = await compressor.plugin.compress(params);

    if (res != null) {
      let result = nullthrows(res.contents ?? res.stream);
      let outputPath = filePath + (res.type != null ? '.' + res.type : '');
      if (result instanceof Readable) {
        await new Promise((resolve, reject) =>
          pipeline(
            result,
            outputFS.createWriteStream(outputPath, writeOptions),
            err => {
              if (err) reject(err);
              else resolve();
            },
          ),
        );
      } else {
        // TODO apply writeOptions.mode
        await outputFS.writeFile(outputPath, result);
      }
    }
  } catch (err) {
    throw new ThrowableDiagnostic({
      diagnostic: errorToDiagnostic(err, {
        origin: compressor.name,
      }),
    });
  } finally {
    // Add dev deps for compressor plugins AFTER running them, to account for lazy require().
    let devDepRequest = await createDevDependency(
      {
        specifier: compressor.name,
        resolveFrom: compressor.resolveFrom,
      },
      devDeps,
      options,
    );
    await runDevDepRequest(api, devDepRequest);
  }
}

function replaceString(hashRefToNameHash, str: string) {
  return str.replace(HASH_REF_REGEX, match => {
    return hashRefToNameHash.get(match) || match;
  });
}

function replaceStream(hashRefToNameHash) {
  let boundaryStr = '';
  return new Transform({
    transform(chunk, encoding, cb) {
      let str = boundaryStr + chunk.toString();
      let replaced = replaceString(hashRefToNameHash, str);
      boundaryStr = replaced.slice(replaced.length - BOUNDARY_LENGTH);
      let strUpToBoundary = replaced.slice(
        0,
        replaced.length - BOUNDARY_LENGTH,
      );
      cb(null, strUpToBoundary);
    },

    flush(cb) {
      cb(null, boundaryStr);
    },
  });
}

function cloneStream(readable) {
  let res = new Readable();
  // $FlowFixMe
  res._read = () => {};
  readable.on('data', chunk => res.push(chunk));
  readable.on('end', () => res.push(null));
  readable.on('error', err => res.emit('error', err));
  return res;
}

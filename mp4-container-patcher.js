(() => {
  const DUMMY_SAMPLE = new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]);
  const SAMPLE_MULTIPLIER = 10;
  const EDIT_DURATION_PADDING_MS = 300;
  const TARGET_ENCODER_TAG = "Lavf60.16.100";
  const ITUNES_ENCODER_BOX = "\xA9too";

  const CONTAINER_TYPES = new Set([
    "moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "meta", "ilst",
  ]);

  function patchKryptonContainer(inputBytes) {
    const source = toUint8Array(inputBytes);
    const root = parseChildren(source, 0, source.byteLength);
    const moov = root.find((box) => box.type === "moov");
    if (!moov) throw new Error("MP4 moov atom not found.");

    const videoTrak = moov.children.find((trak) => trak.type === "trak" && getTrackKind(trak, source) === "vide");
    if (!videoTrak) throw new Error("MP4 video track not found.");

    const stbl = findBox(videoTrak, ["mdia", "minf", "stbl"]);
    const stsz = findBox(stbl, ["stsz"]);
    const stco = findBox(stbl, ["stco"]) || findBox(stbl, ["co64"]);
    const stsc = findBox(stbl, ["stsc"]);
    const stts = findBox(stbl, ["stts"]);
    const mdhd = findBox(videoTrak, ["mdia", "mdhd"]);
    const encoderTag = findBox(moov, ["udta", "meta", "ilst", ITUNES_ENCODER_BOX]);
    if (!stsz || !stco || !stsc || !stts || !mdhd) {
      throw new Error("MP4 video sample tables are incomplete.");
    }

    const realSampleSizes = readStsz(source, stsz);
    const realSampleCount = realSampleSizes.length;
    if (realSampleCount < 1) throw new Error("Video track has no samples.");

    const dummyCount = realSampleCount * (SAMPLE_MULTIPLIER - 1);
    const totalSampleCount = realSampleCount + dummyCount;
    const sampleDuration = inferSampleDuration(source, stts, realSampleCount);

    const oldMoovSize = moov.size;
    const oldMdat = root.find((box) => box.type === "mdat");
    if (!oldMdat) throw new Error("MP4 mdat atom not found.");

    const patchedMoovFirstPass = rebuildBox(source, moov, {
      videoTrak,
      stbl,
      extendEditDuration: true,
      replacements: makeReplacements({
        source,
        encoderTag,
        stsz,
        stts,
        stsc,
        stco,
        realSampleSizes,
        realSampleCount,
        dummyCount,
        totalSampleCount,
        sampleDuration,
        dummyOffset: 0,
      }),
    });

    const mdatShift = patchedMoovFirstPass.byteLength - oldMoovSize;
    const oldFileWithoutMoov = source.byteLength - oldMoovSize;
    const finalSizeBeforeDummy = oldFileWithoutMoov + patchedMoovFirstPass.byteLength;
    const dummyOffset = finalSizeBeforeDummy;

    const patchedMoov = rebuildBox(source, moov, {
      videoTrak,
      stbl,
      extendEditDuration: true,
      replacements: makeReplacements({
        source,
        encoderTag,
        stsz,
        stts,
        stsc,
        stco,
        realSampleSizes,
        realSampleCount,
        dummyCount,
        totalSampleCount,
        sampleDuration,
        dummyOffset,
      }),
    });

    const finalMdatShift = patchedMoov.byteLength - oldMoovSize;
    const chunks = orderTopLevelLikeReference(root, source, patchedMoov);
    chunks.push(DUMMY_SAMPLE);

    const output = concat(chunks);
    patchChunkOffsets(output, finalMdatShift);
    return output;
  }

  function makeReplacements(opts) {
    const replacements = makeVideoTableReplacements(opts);
    if (opts.encoderTag) {
      replacements.set(opts.encoderTag, makeIlstStringBox(ITUNES_ENCODER_BOX, TARGET_ENCODER_TAG));
    }
    return replacements;
  }

  function orderTopLevelLikeReference(root, source, patchedMoov) {
    const chunks = [];
    const pushType = (type) => {
      for (const box of root) {
        if (box.type === type) chunks.push(source.subarray(box.start, box.end));
      }
    };

    pushType("ftyp");
    pushType("free");
    chunks.push(patchedMoov);
    for (const box of root) {
      if (box.type !== "ftyp" && box.type !== "free" && box.type !== "moov" && box.type !== "mdat") {
        chunks.push(source.subarray(box.start, box.end));
      }
    }
    pushType("mdat");
    return chunks;
  }

  function makeVideoTableReplacements(opts) {
    const oldOffsets = readChunkOffsets(opts.source, opts.stco);
    const dummyOffsets = Array(opts.dummyCount).fill(opts.dummyOffset);
    return new Map([
      [opts.stts, makeStts(opts.stts, opts.realSampleCount, opts.dummyCount, opts.sampleDuration)],
      [opts.stsz, makeStsz(opts.stsz, opts.realSampleSizes, opts.dummyCount)],
      [opts.stsc, makeStsc(opts.source, opts.stsc, oldOffsets.length)],
      [opts.stco, makeChunkOffsets(opts.stco.type, oldOffsets.concat(dummyOffsets))],
    ]);
  }

  function parseChildren(bytes, start, end) {
    const boxes = [];
    let offset = start;
    while (offset + 8 <= end) {
      const size32 = readU32(bytes, offset);
      const type = readType(bytes, offset + 4);
      let header = 8;
      let size = size32;
      if (size32 === 1) {
        size = Number(readU64(bytes, offset + 8));
        header = 16;
      } else if (size32 === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) break;
      const box = { type, start: offset, end: offset + size, size, header, children: [] };
      const childStart = offset + header + (type === "meta" ? 4 : 0);
      if (CONTAINER_TYPES.has(type) && childStart < box.end) {
        box.children = parseChildren(bytes, childStart, box.end);
      }
      boxes.push(box);
      offset += size;
    }
    return boxes;
  }

  function rebuildBox(source, box, context) {
    if (context.replacements?.has(box)) return context.replacements.get(box);

    let payload;
    const childrenStart = box.start + box.header + (box.type === "meta" ? 4 : 0);
    if (box.children.length > 0) {
      const prefix = source.subarray(box.start + box.header, childrenStart);
      const children = box.children.map((child) => rebuildBox(source, child, context));
      payload = concat([prefix, ...children]);
    } else {
      payload = source.subarray(box.start + box.header, box.end);
    }

    const rebuilt = makeBox(box.type, payload);
    if (context.extendEditDuration) patchContainerDurations(rebuilt, box.type);
    return rebuilt;
  }

  function patchContainerDurations(boxBytes, type) {
    if (type === "mvhd") {
      patchMovieHeaderDuration(boxBytes);
    } else if (type === "tkhd") {
      patchTrackHeaderDuration(boxBytes);
    } else if (type === "elst") {
      patchEditListDuration(boxBytes);
    }
  }

  function patchMovieHeaderDuration(boxBytes) {
    const version = boxBytes[8];
    if (version === 1) {
      const timescale = readU32(boxBytes, 28);
      const durationOffset = 32;
      writeU64(boxBytes, durationOffset, readU64(boxBytes, durationOffset) + BigInt(msToTicks(EDIT_DURATION_PADDING_MS, timescale)));
      return;
    }

    const timescale = readU32(boxBytes, 20);
    const durationOffset = 24;
    writeU32(boxBytes, durationOffset, readU32(boxBytes, durationOffset) + msToTicks(EDIT_DURATION_PADDING_MS, timescale));
  }

  function patchTrackHeaderDuration(boxBytes) {
    const version = boxBytes[8];
    if (version === 1) {
      const durationOffset = 36;
      const movieTimescale = 1000;
      writeU64(boxBytes, durationOffset, readU64(boxBytes, durationOffset) + BigInt(msToTicks(EDIT_DURATION_PADDING_MS, movieTimescale)));
      return;
    }

    const durationOffset = 28;
    const movieTimescale = 1000;
    writeU32(boxBytes, durationOffset, readU32(boxBytes, durationOffset) + msToTicks(EDIT_DURATION_PADDING_MS, movieTimescale));
  }

  function patchEditListDuration(boxBytes) {
    const version = boxBytes[8];
    const entryCount = readU32(boxBytes, 12);
    if (entryCount < 1) return;

    const firstSegmentDurationOffset = 16;
    const movieTimescale = 1000;
    if (version === 1) {
      writeU64(
        boxBytes,
        firstSegmentDurationOffset,
        readU64(boxBytes, firstSegmentDurationOffset) + BigInt(msToTicks(EDIT_DURATION_PADDING_MS, movieTimescale)),
      );
      return;
    }

    writeU32(
      boxBytes,
      firstSegmentDurationOffset,
      readU32(boxBytes, firstSegmentDurationOffset) + msToTicks(EDIT_DURATION_PADDING_MS, movieTimescale),
    );
  }

  function msToTicks(milliseconds, timescale) {
    return Math.round((milliseconds * timescale) / 1000);
  }

  function patchChunkOffsets(output, shift) {
    if (shift === 0) return;
    const root = parseChildren(output, 0, output.byteLength);
    forEachBox(root, (box) => {
      if (box.type !== "stco" && box.type !== "co64") return;
      const count = readU32(output, box.start + 12);
      let cursor = box.start + 16;
      for (let i = 0; i < count; i += 1) {
        if (box.type === "co64") {
          const value = readU64(output, cursor);
          if (value < BigInt(output.byteLength - DUMMY_SAMPLE.byteLength)) writeU64(output, cursor, value + BigInt(shift));
          cursor += 8;
        } else {
          const value = readU32(output, cursor);
          if (value < output.byteLength - DUMMY_SAMPLE.byteLength) writeU32(output, cursor, value + shift);
          cursor += 4;
        }
      }
    });
  }

  function forEachBox(boxes, callback) {
    for (const box of boxes) {
      callback(box);
      forEachBox(box.children, callback);
    }
  }

  function getTrackKind(trak, source) {
    const hdlr = findBox(trak, ["mdia", "hdlr"]);
    return hdlr ? readType(source, hdlr.start + hdlr.header + 8) : null;
  }

  function findBox(parent, path) {
    let current = parent;
    for (const type of path) {
      current = current?.children?.find((box) => box.type === type);
      if (!current) return null;
    }
    return current;
  }

  function readStsz(bytes, box) {
    const sampleSize = readU32(bytes, box.start + 12);
    const count = readU32(bytes, box.start + 16);
    if (sampleSize !== 0) return Array(count).fill(sampleSize);
    const sizes = [];
    let cursor = box.start + 20;
    for (let i = 0; i < count; i += 1) {
      sizes.push(readU32(bytes, cursor));
      cursor += 4;
    }
    return sizes;
  }

  function inferSampleDuration(bytes, stts, sampleCount) {
    const entryCount = readU32(bytes, stts.start + 12);
    if (entryCount < 1) return 1000;
    return readU32(bytes, stts.start + 20) || Math.round(60000 / 60);
  }

  function readChunkOffsets(bytes, box) {
    const count = readU32(bytes, box.start + 12);
    const offsets = [];
    let cursor = box.start + 16;
    for (let i = 0; i < count; i += 1) {
      offsets.push(box.type === "co64" ? Number(readU64(bytes, cursor)) : readU32(bytes, cursor));
      cursor += box.type === "co64" ? 8 : 4;
    }
    return offsets;
  }

  function makeStts(oldBox, realCount, dummyCount, sampleDuration) {
    const payload = new Uint8Array(24);
    payload.set([0, 0, 0, 0], 0);
    writeU32(payload, 4, 2);
    writeU32(payload, 8, realCount);
    writeU32(payload, 12, sampleDuration);
    writeU32(payload, 16, dummyCount);
    writeU32(payload, 20, sampleDuration);
    return makeBox("stts", payload);
  }

  function makeStsz(oldBox, realSizes, dummyCount) {
    const payload = new Uint8Array(12 + (realSizes.length + dummyCount) * 4);
    payload.set([0, 0, 0, 0], 0);
    writeU32(payload, 4, 0);
    writeU32(payload, 8, realSizes.length + dummyCount);
    let cursor = 12;
    for (const size of realSizes) {
      writeU32(payload, cursor, size);
      cursor += 4;
    }
    for (let i = 0; i < dummyCount; i += 1) {
      writeU32(payload, cursor, DUMMY_SAMPLE.byteLength);
      cursor += 4;
    }
    return makeBox("stsz", payload);
  }

  function makeStsc(source, stsc, oldChunkCount) {
    const entries = readStscEntries(source, stsc);
    const dummyFirstChunk = oldChunkCount + 1;
    const last = entries[entries.length - 1];
    if (!last || last.firstChunk !== dummyFirstChunk || last.samplesPerChunk !== 1) {
      entries.push({ firstChunk: dummyFirstChunk, samplesPerChunk: 1, sampleDescIndex: 1 });
    }
    const payload = new Uint8Array(8 + entries.length * 12);
    payload.set([0, 0, 0, 0], 0);
    writeU32(payload, 4, entries.length);
    let cursor = 8;
    for (const entry of entries) {
      writeU32(payload, cursor, entry.firstChunk);
      writeU32(payload, cursor + 4, entry.samplesPerChunk);
      writeU32(payload, cursor + 8, entry.sampleDescIndex);
      cursor += 12;
    }
    return makeBox("stsc", payload);
  }

  function readStscEntries(source, stsc) {
    const count = readU32(source, stsc.start + 12);
    const entries = [];
    let cursor = stsc.start + 16;
    for (let i = 0; i < count; i += 1) {
      entries.push({
        firstChunk: readU32(source, cursor),
        samplesPerChunk: readU32(source, cursor + 4),
        sampleDescIndex: readU32(source, cursor + 8),
      });
      cursor += 12;
    }
    return entries;
  }

  function makeChunkOffsets(type, offsets) {
    const is64 = type === "co64" || offsets.some((offset) => offset > 0xffffffff);
    const payload = new Uint8Array(8 + offsets.length * (is64 ? 8 : 4));
    payload.set([0, 0, 0, 0], 0);
    writeU32(payload, 4, offsets.length);
    let cursor = 8;
    for (const offset of offsets) {
      if (is64) {
        writeU64(payload, cursor, BigInt(offset));
        cursor += 8;
      } else {
        writeU32(payload, cursor, offset);
        cursor += 4;
      }
    }
    return makeBox(is64 ? "co64" : "stco", payload);
  }

  function makeBox(type, payload) {
    const out = new Uint8Array(8 + payload.byteLength);
    writeU32(out, 0, out.byteLength);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(payload, 8);
    return out;
  }

  function makeIlstStringBox(type, value) {
    const text = asciiBytes(value);
    const dataPayload = new Uint8Array(8 + text.byteLength);
    writeU32(dataPayload, 0, 1);
    writeU32(dataPayload, 4, 0);
    dataPayload.set(text, 8);
    return makeBox(type, makeBox("data", dataPayload));
  }

  function asciiBytes(value) {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i) & 0x7f;
    return out;
  }

  function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  function toUint8Array(value) {
    if (value instanceof Uint8Array) return value;
    return new Uint8Array(value);
  }

  function readType(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  }

  function readU32(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  }

  function writeU32(bytes, offset, value) {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
  }

  function readU64(bytes, offset) {
    return (BigInt(readU32(bytes, offset)) << 32n) | BigInt(readU32(bytes, offset + 4));
  }

  function writeU64(bytes, offset, value) {
    writeU32(bytes, offset, Number((value >> 32n) & 0xffffffffn));
    writeU32(bytes, offset + 4, Number(value & 0xffffffffn));
  }

  window.KryptonMp4Patcher = { patchKryptonContainer };
})();

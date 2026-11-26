'use strict';

/**
 * H.264 工具：按 Annex-B 起始码切 NAL，并从 SPS 推导 WebCodecs 需要的 codec string。
 * codec string 必须来自真实码流（不同机型的 profile/level 不同），不能硬编码。
 */

/** 切出 NAL 单元（不含起始码），三字节与四字节起始码都支持。 */
function findNalUnits(bytes) {
  const nals = [];
  let start = -1;
  for (let i = 0; i + 3 <= bytes.length;) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      if (start >= 0) {
        // 四字节起始码时，末尾会多出一个 0，剔除
        let end = i;
        if (end > start && bytes[end - 1] === 0) end--;
        nals.push(bytes.subarray(start, end));
      }
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < bytes.length) {
    nals.push(bytes.subarray(start));
  }
  return nals;
}

/** 取 NAL 类型（SPS=7 / PPS=8 / IDR=5）。 */
function nalType(nal) {
  return nal && nal.length ? nal[0] & 0x1f : -1;
}

/** 从 SPS NAL（首字节为 0x67）算出 RFC 6381 的 avc1.PPCCLL。 */
function avc1CodecString(sps) {
  if (!sps || sps.length < 4 || nalType(sps) !== 7) {
    throw new Error('not an SPS NAL');
  }
  const hex = (value) => value.toString(16).toUpperCase().padStart(2, '0');
  const profile = sps[1];
  const compat = sps[2];
  const level = sps[3];
  // Level 1b：level_idc=11 且 constraint_set3_flag(0x10) 置位
  const levelPart = level === 11 && (compat & 0x10) !== 0 ? '1b' : hex(level);
  return `avc1.${hex(profile)}${hex(compat)}${levelPart}`;
}

module.exports = { findNalUnits, nalType, avc1CodecString };

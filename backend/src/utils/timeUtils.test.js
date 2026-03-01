import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nowJST } from './timeUtils.js';

describe('nowJST', () => {
  let dateNowSpy;

  beforeEach(() => {
    dateNowSpy = vi.spyOn(Date, 'now');
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  it('formats epoch (0) as 1970/01/01 09:00:00 JST', () => {
    dateNowSpy.mockReturnValue(0);
    const result = nowJST();
    expect(result).toBe('1970/01/01 09:00:00 JST');
  });

  it('formats 2024-02-07T00:00:00Z as 2024/02/07 09:00:00 JST', () => {
    // 2024-02-07T00:00:00Z
    dateNowSpy.mockReturnValue(1707264000000);
    const result = nowJST();
    expect(result).toBe('2024/02/07 09:00:00 JST');
  });

  it('pads day, hour, minute, second to 2 digits', () => {
    // 2024-01-01T00:01:02Z → 2024/01/01 09:01:02 JST
    dateNowSpy.mockReturnValue(1704067262000);
    const result = nowJST();
    expect(result).toBe('2024/01/01 09:01:02 JST');
  });

  it('pads month to 2 digits (month = 1)', () => {
    // 2024-01-15T00:00:00Z → 2024/01/15 09:00:00 JST
    dateNowSpy.mockReturnValue(1705276800000);
    const result = nowJST();
    expect(result).toBe('2024/01/15 09:00:00 JST');
    // Verify month is '01', not '1'
    expect(result.split('/')[1]).toBe('01');
  });

  it('pads month to 2 digits (month = 2)', () => {
    // 2024-02-01T00:00:00Z → 2024/02/01 09:00:00 JST
    dateNowSpy.mockReturnValue(1706745600000);
    const result = nowJST();
    expect(result).toBe('2024/02/01 09:00:00 JST');
    expect(result.split('/')[1]).toBe('02');
  });

  it('handles December (month = 12)', () => {
    // 2024-12-01T00:00:00Z → 2024/12/01 09:00:00 JST
    dateNowSpy.mockReturnValue(1733011200000);
    const result = nowJST();
    expect(result).toBe('2024/12/01 09:00:00 JST');
    expect(result.split('/')[1]).toBe('12');
  });

  it('applies +9 hour offset correctly', () => {
    // 2024-06-15T00:00:00Z → 2024/06/15 09:00:00 JST
    dateNowSpy.mockReturnValue(1718409600000);
    const result = nowJST();
    expect(result).toBe('2024/06/15 09:00:00 JST');
  });

  it('handles midnight boundary (23:xx UTC → 08:xx+1 JST next day)', () => {
    // 2024-02-06T23:30:45Z → 2024/02/07 08:30:45 JST
    dateNowSpy.mockReturnValue(1707262245000);
    const result = nowJST();
    expect(result).toBe('2024/02/07 08:30:45 JST');
  });

  it('handles year boundary (Dec 31 23:59:59 UTC → Jan 1 08:59:59 JST)', () => {
    // 2023-12-31T23:59:59Z → 2024/01/01 08:59:59 JST
    dateNowSpy.mockReturnValue(1704067199000);
    const result = nowJST();
    expect(result).toBe('2024/01/01 08:59:59 JST');
  });

  it('handles year boundary (Jan 1 00:00:00 UTC → Jan 1 09:00:00 JST)', () => {
    // 2024-01-01T00:00:00Z → 2024/01/01 09:00:00 JST
    dateNowSpy.mockReturnValue(1704067200000);
    const result = nowJST();
    expect(result).toBe('2024/01/01 09:00:00 JST');
  });

  it('always ends with " JST" suffix', () => {
    dateNowSpy.mockReturnValue(1707264000000);
    const result = nowJST();
    expect(result.endsWith(' JST')).toBe(true);
  });

  it('has correct year value (not off by one)', () => {
    // 2025-05-10T12:34:56Z → 2025/05/10 21:34:56 JST
    dateNowSpy.mockReturnValue(1746880496000);
    const result = nowJST();
    expect(result).toBe('2025/05/10 21:34:56 JST');
    const year = parseInt(result.split('/')[0], 10);
    expect(year).toBe(2025);
  });

  it('has correct month value (1-indexed, not 0-indexed)', () => {
    // Test all months to ensure +1 offset is applied
    const testCases = [
      { timestamp: 1704067200000, expected: '2024/01/01 09:00:00 JST' }, // Jan
      { timestamp: 1706745600000, expected: '2024/02/01 09:00:00 JST' }, // Feb
      { timestamp: 1709251200000, expected: '2024/03/01 09:00:00 JST' }, // Mar
      { timestamp: 1711929600000, expected: '2024/04/01 09:00:00 JST' }, // Apr
      { timestamp: 1714521600000, expected: '2024/05/01 09:00:00 JST' }, // May
      { timestamp: 1717200000000, expected: '2024/06/01 09:00:00 JST' }, // Jun
      { timestamp: 1719792000000, expected: '2024/07/01 09:00:00 JST' }, // Jul
      { timestamp: 1722470400000, expected: '2024/08/01 09:00:00 JST' }, // Aug
      { timestamp: 1725148800000, expected: '2024/09/01 09:00:00 JST' }, // Sep
      { timestamp: 1727740800000, expected: '2024/10/01 09:00:00 JST' }, // Oct
      { timestamp: 1730419200000, expected: '2024/11/01 09:00:00 JST' }, // Nov
      { timestamp: 1733011200000, expected: '2024/12/01 09:00:00 JST' }, // Dec
    ];

    testCases.forEach(({ timestamp, expected }) => {
      dateNowSpy.mockReturnValue(timestamp);
      expect(nowJST()).toBe(expected);
    });
  });

  it('pads day to 2 digits (tests all single digits)', () => {
    const testCases = [
      { timestamp: 1704067200000, day: '01' }, // 2024-01-01
      { timestamp: 1704153600000, day: '02' }, // 2024-01-02
      { timestamp: 1704240000000, day: '03' }, // 2024-01-03
      { timestamp: 1704326400000, day: '04' }, // 2024-01-04
      { timestamp: 1704412800000, day: '05' }, // 2024-01-05
      { timestamp: 1704499200000, day: '06' }, // 2024-01-06
      { timestamp: 1704585600000, day: '07' }, // 2024-01-07
      { timestamp: 1704672000000, day: '08' }, // 2024-01-08
      { timestamp: 1704758400000, day: '09' }, // 2024-01-09
    ];

    testCases.forEach(({ timestamp, day }) => {
      dateNowSpy.mockReturnValue(timestamp);
      const result = nowJST();
      expect(result.split(' ')[0].split('/')[2]).toBe(day);
    });
  });

  it('pads hour to 2 digits (tests single digit hours)', () => {
    // 2024-01-01T00:00:00Z → hour = 09
    dateNowSpy.mockReturnValue(1704067200000);
    let result = nowJST();
    expect(result.split(' ')[1].split(':')[0]).toBe('09');

    // 2024-01-01T01:00:00Z → hour = 10
    dateNowSpy.mockReturnValue(1704070800000);
    result = nowJST();
    expect(result.split(' ')[1].split(':')[0]).toBe('10');

    // 2024-01-01T15:00:00Z → hour = 00 (next day)
    dateNowSpy.mockReturnValue(1704121200000);
    result = nowJST();
    expect(result.split(' ')[1].split(':')[0]).toBe('00');
  });

  it('pads minute to 2 digits (tests all single digit minutes)', () => {
    const testCases = [
      { offset: 0, minute: '00' },
      { offset: 60000, minute: '01' },
      { offset: 120000, minute: '02' },
      { offset: 180000, minute: '03' },
      { offset: 240000, minute: '04' },
      { offset: 300000, minute: '05' },
      { offset: 360000, minute: '06' },
      { offset: 420000, minute: '07' },
      { offset: 480000, minute: '08' },
      { offset: 540000, minute: '09' },
    ];

    testCases.forEach(({ offset, minute }) => {
      dateNowSpy.mockReturnValue(1704067200000 + offset);
      const result = nowJST();
      expect(result.split(':')[1]).toBe(minute);
    });
  });

  it('pads second to 2 digits (tests all single digit seconds)', () => {
    const testCases = [
      { offset: 0, second: '00' },
      { offset: 1000, second: '01' },
      { offset: 2000, second: '02' },
      { offset: 3000, second: '03' },
      { offset: 4000, second: '04' },
      { offset: 5000, second: '05' },
      { offset: 6000, second: '06' },
      { offset: 7000, second: '07' },
      { offset: 8000, second: '08' },
      { offset: 9000, second: '09' },
    ];

    testCases.forEach(({ offset, second }) => {
      dateNowSpy.mockReturnValue(1704067200000 + offset);
      const result = nowJST();
      expect(result.split(':')[2].split(' ')[0]).toBe(second);
    });
  });

  it('verifies exact +9 hour offset (32400000 ms)', () => {
    // 2024-01-01T00:00:00Z (1704067200000)
    // Expected JST: 2024-01-01T09:00:00 JST
    dateNowSpy.mockReturnValue(1704067200000);
    const result = nowJST();

    // Parse result and verify it's exactly 9 hours ahead
    const utcDate = new Date(1704067200000);
    const jstDate = new Date(1704067200000 + 9 * 60 * 60 * 1000);

    expect(result).toBe('2024/01/01 09:00:00 JST');
    expect(jstDate.getUTCHours()).toBe(9);
    expect(utcDate.getUTCHours()).toBe(0);
  });

  it('handles leap year (Feb 29)', () => {
    // 2024-02-29T12:00:00Z (leap year) → 2024/02/29 21:00:00 JST
    dateNowSpy.mockReturnValue(1709208000000);
    const result = nowJST();
    expect(result).toBe('2024/02/29 21:00:00 JST');
  });

  it('handles end of month boundaries correctly', () => {
    // 2024-01-31T23:59:59Z → 2024/02/01 08:59:59 JST
    dateNowSpy.mockReturnValue(1706745599000);
    const result = nowJST();
    expect(result).toBe('2024/02/01 08:59:59 JST');
  });

  it('verifies format structure: YYYY/MM/DD HH:mm:ss JST', () => {
    dateNowSpy.mockReturnValue(1707264000000);
    const result = nowJST();

    // Match pattern: 4-digit year / 2-digit month / 2-digit day space 2-digit hour : 2-digit minute : 2-digit second space JST
    const pattern = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} JST$/;
    expect(result).toMatch(pattern);
  });

  it('ensures day is always 2 digits (10-31)', () => {
    // 2024-01-10T00:00:00Z → day = 10
    dateNowSpy.mockReturnValue(1704844800000);
    let result = nowJST();
    expect(result.split(' ')[0].split('/')[2]).toBe('10');

    // 2024-01-31T00:00:00Z → day = 31
    dateNowSpy.mockReturnValue(1706659200000);
    result = nowJST();
    expect(result.split(' ')[0].split('/')[2]).toBe('31');
  });

  it('ensures hour is always 2 digits (10-23)', () => {
    // 2024-01-01T01:00:00Z → hour = 10
    dateNowSpy.mockReturnValue(1704070800000);
    let result = nowJST();
    expect(result.split(' ')[1].split(':')[0]).toBe('10');

    // 2024-01-01T14:00:00Z → hour = 23
    dateNowSpy.mockReturnValue(1704117600000);
    result = nowJST();
    expect(result.split(' ')[1].split(':')[0]).toBe('23');
  });

  it('ensures minute is always 2 digits (10-59)', () => {
    // 10 minutes
    dateNowSpy.mockReturnValue(1704067800000);
    let result = nowJST();
    expect(result.split(':')[1]).toBe('10');

    // 59 minutes
    dateNowSpy.mockReturnValue(1704070740000);
    result = nowJST();
    expect(result.split(':')[1]).toBe('59');
  });

  it('ensures second is always 2 digits (10-59)', () => {
    // 10 seconds
    dateNowSpy.mockReturnValue(1704067210000);
    let result = nowJST();
    expect(result.split(':')[2].split(' ')[0]).toBe('10');

    // 59 seconds
    dateNowSpy.mockReturnValue(1704067259000);
    result = nowJST();
    expect(result.split(':')[2].split(' ')[0]).toBe('59');
  });

  it('verifies the offset is exactly 9 hours (not 8 or 10)', () => {
    const utcTimestamp = 1704067200000; // 2024-01-01T00:00:00Z

    // Test with 9 hours (correct)
    dateNowSpy.mockReturnValue(utcTimestamp);
    expect(nowJST()).toBe('2024/01/01 09:00:00 JST');

    // If offset were 8 hours, it would show 08:00:00
    // If offset were 10 hours, it would show 10:00:00
    const jstDate = new Date(utcTimestamp + 9 * 60 * 60 * 1000);
    expect(jstDate.getUTCHours()).toBe(9);
  });
});

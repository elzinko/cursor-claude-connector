import { describe, expect, it } from 'vitest'
import {
  classifyNetType,
  formatHostLabel,
  isPrivateIp,
  parsePtr,
  shortenOrg,
} from '../../src/middleware/ip-provenance'

describe('parsePtr', () => {
  it('extracts AWS region from ec2-*.<region>.compute.amazonaws.com', () => {
    expect(
      parsePtr('ec2-13-38-80-221.eu-west-3.compute.amazonaws.com'),
    ).toBe('AWS eu-west-3')
    expect(
      parsePtr('ec2-52-57-1-2.eu-central-1.compute.amazonaws.com'),
    ).toBe('AWS eu-central-1')
  })

  it('maps us-east-1 legacy naming', () => {
    expect(parsePtr('ec2-54-1-2-3.compute-1.amazonaws.com')).toBe(
      'AWS us-east-1',
    )
  })

  it('falls back to generic "AWS" for other amazonaws hosts', () => {
    expect(parsePtr('some.random.amazonaws.com')).toBe('AWS')
  })

  it('extracts Azure region from *.<region>.cloudapp.azure.com', () => {
    expect(parsePtr('foo.eastus.cloudapp.azure.com')).toBe('Azure eastus')
  })

  it('falls back to "Azure" for base cloudapp.azure.com', () => {
    expect(parsePtr('host.cloudapp.azure.com')).toBe('Azure')
  })

  it('recognizes GCP hosts', () => {
    expect(parsePtr('1.2.3.4.bc.googleusercontent.com')).toBe('GCP')
    expect(parsePtr('host.googleusercontent.com')).toBe('GCP')
  })

  it('recognizes 1e100 as Google', () => {
    expect(parsePtr('ams15s01-in-f14.1e100.net')).toBe('Google')
  })

  it('recognizes common hosters', () => {
    expect(parsePtr('x.digitalocean.com')).toBe('DigitalOcean')
    expect(parsePtr('ns1.linode.com')).toBe('Linode')
    expect(parsePtr('host.ovh.net')).toBe('OVH')
    expect(parsePtr('static.hetzner.com')).toBe('Hetzner')
    expect(parsePtr('static.12-34.your-server.de')).toBe('Hetzner')
  })

  it('is case-insensitive and strips trailing dot', () => {
    expect(
      parsePtr('EC2-13-38-80-221.EU-WEST-3.COMPUTE.AMAZONAWS.COM.'),
    ).toBe('AWS eu-west-3')
  })

  it('returns null for unknown / empty / nullish', () => {
    expect(parsePtr(null)).toBe(null)
    expect(parsePtr(undefined)).toBe(null)
    expect(parsePtr('')).toBe(null)
    expect(parsePtr('some-random-isp.example.com')).toBe(null)
  })
})

describe('classifyNetType', () => {
  it('returns hosting when PTR matched a cloud provider (trumps everything)', () => {
    expect(
      classifyNetType(
        'Société Française du Radiotéléphone - SFR SA',
        'isp',
        'AWS eu-west-3',
      ),
    ).toBe('hosting')
  })

  it('honors ipinfo type=hosting', () => {
    expect(classifyNetType('Amazon.com, Inc.', 'hosting', null)).toBe('hosting')
  })

  it('honors ipinfo type=isp and detects mobile via ASN org', () => {
    expect(classifyNetType('Free Mobile', 'isp', null)).toBe('mobile')
    expect(classifyNetType('SFR Mobile', 'isp', null)).toBe('mobile')
  })

  it('defaults ISP to residential', () => {
    expect(classifyNetType('SFR', 'isp', null)).toBe('residential')
  })

  it('maps business/education/government to business', () => {
    expect(classifyNetType('Some University', 'education', null)).toBe(
      'business',
    )
    expect(classifyNetType('Gov Agency', 'government', null)).toBe('business')
    expect(classifyNetType('BigCo', 'business', null)).toBe('business')
  })

  it('falls back to hosting regex when ipinfo type missing', () => {
    expect(classifyNetType('Amazon.com, Inc.', null, null)).toBe('hosting')
    expect(classifyNetType('Microsoft Corporation', null, null)).toBe('hosting')
    expect(classifyNetType('OVH SAS', null, null)).toBe('hosting')
    expect(classifyNetType('Hetzner Online GmbH', null, null)).toBe('hosting')
  })

  it('returns residential for unknown-but-named ISP with no hosting/mobile hit', () => {
    expect(classifyNetType('Some Local ISP', null, null)).toBe('residential')
  })

  it('returns unknown when nothing is known', () => {
    expect(classifyNetType(null, null, null)).toBe('unknown')
    expect(classifyNetType(undefined, undefined, undefined)).toBe('unknown')
  })
})

describe('shortenOrg', () => {
  it('strips leading "AS<n> " prefix', () => {
    expect(shortenOrg('AS16509 Amazon.com, Inc.')).toBe('Amazon.com')
  })

  it('strips trailing corporate suffixes', () => {
    expect(shortenOrg('Amazon.com, Inc.')).toBe('Amazon.com')
    expect(shortenOrg('OVH SAS')).toBe('OVH')
    expect(shortenOrg('Hetzner Online GmbH')).toBe('Hetzner Online')
  })

  it('prefers short recognizable token in "X - Y" splits', () => {
    expect(
      shortenOrg('Société Française du Radiotéléphone - SFR SA'),
    ).toBe('SFR')
  })
})

describe('formatHostLabel', () => {
  it('uses PTR label when available', () => {
    expect(
      formatHostLabel({
        asn: 16509,
        asnOrg: 'Amazon.com, Inc.',
        ptrLabel: 'AWS eu-west-3',
        netType: 'hosting',
        country: 'FR',
      }),
    ).toBe('AWS eu-west-3')
  })

  it('formats residential with country + netType', () => {
    expect(
      formatHostLabel({
        asn: 15557,
        asnOrg: 'Société Française du Radiotéléphone - SFR SA',
        ptrLabel: null,
        netType: 'residential',
        country: 'FR',
      }),
    ).toBe('SFR (FR, residential)')
  })

  it('formats mobile / business similarly', () => {
    expect(
      formatHostLabel({
        asn: 1,
        asnOrg: 'Free Mobile',
        ptrLabel: null,
        netType: 'mobile',
        country: 'FR',
      }),
    ).toBe('Free Mobile (FR, mobile)')
  })

  it('returns bare org for hosting without PTR (e.g. no reverse DNS)', () => {
    expect(
      formatHostLabel({
        asn: 8075,
        asnOrg: 'Microsoft Corporation',
        ptrLabel: null,
        netType: 'hosting',
        country: 'US',
      }),
    ).toBe('Microsoft')
  })

  it('falls back to AS<n> when no org', () => {
    expect(
      formatHostLabel({
        asn: 12345,
        asnOrg: null,
        ptrLabel: null,
        netType: 'unknown',
        country: null,
      }),
    ).toBe('AS12345')
  })

  it('returns null when we have nothing', () => {
    expect(
      formatHostLabel({
        asn: null,
        asnOrg: null,
        ptrLabel: null,
        netType: 'unknown',
        country: null,
      }),
    ).toBe(null)
  })
})

describe('isPrivateIp', () => {
  it('flags RFC1918 / loopback / link-local', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true)
    expect(isPrivateIp('192.168.1.1')).toBe(true)
    expect(isPrivateIp('172.16.0.1')).toBe(true)
    expect(isPrivateIp('172.31.255.255')).toBe(true)
    expect(isPrivateIp('127.0.0.1')).toBe(true)
    expect(isPrivateIp('169.254.1.1')).toBe(true)
  })

  it('flags IPv6 ULA / link-local / loopback', () => {
    expect(isPrivateIp('::1')).toBe(true)
    expect(isPrivateIp('fe80::1')).toBe(true)
    expect(isPrivateIp('fd00::1')).toBe(true)
    expect(isPrivateIp('fc00::1')).toBe(true)
  })

  it('flags empty / unknown', () => {
    expect(isPrivateIp('')).toBe(true)
    expect(isPrivateIp('unknown')).toBe(true)
  })

  it('leaves public IPs alone', () => {
    expect(isPrivateIp('37.65.35.26')).toBe(false)
    expect(isPrivateIp('13.38.80.221')).toBe(false)
    expect(isPrivateIp('172.15.0.1')).toBe(false) // outside 172.16/12
    expect(isPrivateIp('172.32.0.1')).toBe(false) // outside 172.16/12
    expect(isPrivateIp('2001:db8::1')).toBe(false)
  })
})

// ── Integration: lookupProvenance fail-safe ─────────────────────────
// We verify the behavior contract without hitting the network:
//   - Private IPs short-circuit to EMPTY_PROVENANCE
//   - If no IPINFO_TOKEN and ipinfo errors, we still return a valid shape
//     without throwing. (We can't easily mock the global fetch here without
//     adding infrastructure; the unit-level guarantee is that the pure
//     classifier/formatter pieces above always produce a safe record, and
//     that private-IP short-circuit never calls out.)
describe('lookupProvenance (fail-safe contract via isPrivateIp)', () => {
  it('returns the empty record shape for private IPs without any network call', async () => {
    const { lookupProvenance, EMPTY_PROVENANCE } = await import(
      '../../src/middleware/ip-provenance'
    )
    const res = await lookupProvenance('127.0.0.1', 'US')
    expect(res).toEqual(EMPTY_PROVENANCE)
    const res2 = await lookupProvenance('unknown', null)
    expect(res2).toEqual(EMPTY_PROVENANCE)
  })
})

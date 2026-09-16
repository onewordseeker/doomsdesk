// Wake-on-LAN — send a magic packet to wake a sleeping machine.
//
// Supports MAC address formats:
//   "AA:BB:CC:DD:EE:FF"   (colon-separated)
//   "AA-BB-CC-DD-EE-FF"   (hyphen-separated)
//   "AABBCCDDEEFF"        (compact hex)
//
// The magic packet is broadcast over UDP to 255.255.255.255 on both port 9
// (the WoL standard) and port 7 (legacy WoL). Both datagrams are sent from
// the same socket so they share a single OS buffer allocation.

use std::net::UdpSocket;

/// Parse a MAC address string into a 6-byte array.
/// Returns Err with a human-readable message on invalid input.
fn parse_mac(mac_str: &str) -> Result<[u8; 6], String> {
    // Normalise: strip separators, uppercase, then expect exactly 12 hex chars.
    let raw: String = mac_str
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect::<String>()
        .to_uppercase();

    if raw.len() != 12 {
        return Err(format!(
            "invalid MAC address '{}': expected 12 hex digits, got {}",
            mac_str,
            raw.len()
        ));
    }

    let mut bytes = [0u8; 6];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&raw[i * 2..i * 2 + 2], 16)
            .map_err(|e| format!("invalid MAC address '{}': {}", mac_str, e))?;
    }
    Ok(bytes)
}

/// Build the 102-byte WoL magic packet:
///   6 bytes of 0xFF  ||  16 repetitions of the 6-byte MAC address
fn build_magic_packet(mac: &[u8; 6]) -> [u8; 102] {
    let mut packet = [0u8; 102];
    // Preamble: six 0xFF bytes
    for b in &mut packet[..6] {
        *b = 0xFF;
    }
    // 16 copies of the target MAC
    for rep in 0..16 {
        let off = 6 + rep * 6;
        packet[off..off + 6].copy_from_slice(mac);
    }
    packet
}

/// Send a Wake-on-LAN magic packet for the given MAC address.
///
/// Broadcasts to 255.255.255.255 on UDP ports 9 and 7.
/// The function returns as soon as both packets are handed to the OS;
/// no acknowledgement is possible with WoL.
pub fn send_wol_packet(mac_addr: &str) -> Result<(), String> {
    let mac = parse_mac(mac_addr)?;
    let packet = build_magic_packet(&mac);

    // Bind on any available port; SO_BROADCAST is required for the broadcast address.
    let socket = UdpSocket::bind("0.0.0.0:0")
        .map_err(|e| format!("WoL: failed to bind UDP socket: {}", e))?;

    socket
        .set_broadcast(true)
        .map_err(|e| format!("WoL: failed to enable broadcast: {}", e))?;

    // Port 9 — standard WoL discard port
    socket
        .send_to(&packet, "255.255.255.255:9")
        .map_err(|e| format!("WoL: send to port 9 failed: {}", e))?;

    // Port 7 — legacy WoL echo port (some firmware only listens here)
    socket
        .send_to(&packet, "255.255.255.255:7")
        .map_err(|e| format!("WoL: send to port 7 failed: {}", e))?;

    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_colon_separated() {
        let mac = parse_mac("AA:BB:CC:DD:EE:FF").unwrap();
        assert_eq!(mac, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    }

    #[test]
    fn parse_hyphen_separated() {
        let mac = parse_mac("AA-BB-CC-DD-EE-FF").unwrap();
        assert_eq!(mac, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    }

    #[test]
    fn parse_compact() {
        let mac = parse_mac("AABBCCDDEEFF").unwrap();
        assert_eq!(mac, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    }

    #[test]
    fn parse_lowercase() {
        let mac = parse_mac("aa:bb:cc:dd:ee:ff").unwrap();
        assert_eq!(mac, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    }

    #[test]
    fn parse_invalid_rejects() {
        assert!(parse_mac("ZZ:BB:CC:DD:EE:FF").is_err());
        assert!(parse_mac("AA:BB:CC:DD:EE").is_err());
        assert!(parse_mac("").is_err());
    }

    #[test]
    fn magic_packet_structure() {
        let mac = [0x00u8, 0x11, 0x22, 0x33, 0x44, 0x55];
        let pkt = build_magic_packet(&mac);
        assert_eq!(pkt.len(), 102);
        // First 6 bytes must be 0xFF
        assert!(pkt[..6].iter().all(|&b| b == 0xFF));
        // Each of the 16 MAC repetitions must match
        for rep in 0..16 {
            let off = 6 + rep * 6;
            assert_eq!(&pkt[off..off + 6], &mac);
        }
    }
}

import CoreGraphics
import Foundation

func postMouse(_ type: CGEventType, x: CGFloat, y: CGFloat, button: CGMouseButton) {
    let event = CGEvent(mouseEventSource: nil, mouseType: type,
                        mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: button)
    event?.post(tap: .cghidEventTap)
}

func postKey(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags = []) {
    let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down)
    event?.flags = flags
    event?.post(tap: .cghidEventTap)
}

let backslash = "\\"
let keyMap: [String: CGKeyCode] = [
    "a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,
    "q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,
    "6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,"]":30,"o":31,
    "u":32,"[":33,"i":34,"p":35,"l":37,"j":38,"'":39,"k":40,";":41,",":43,
    "/":44,"n":45,"m":46,".":47,"`":50,
    "Enter":36,"Tab":48," ":49,"Backspace":51,"Escape":53,"Delete":117,
    "Meta":55,"Shift":56,"CapsLock":57,"Alt":58,"Control":59,
    "ArrowRight":124,"ArrowLeft":123,"ArrowDown":125,"ArrowUp":126,
    "Home":115,"End":119,"PageUp":116,"PageDown":121,
    "F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,
    "F7":98,"F8":100,"F9":101,"F10":109,"F11":103,"F12":111,
]

var fullKeyMap = keyMap
fullKeyMap[backslash] = 42

print("READY")
fflush(stdout)

while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = json["type"] as? String else { continue }

    let x = CGFloat((json["x"] as? NSNumber)?.doubleValue ?? 0)
    let y = CGFloat((json["y"] as? NSNumber)?.doubleValue ?? 0)
    let button = json["button"] as? String ?? "left"
    let mods = json["modifiers"] as? [String: Bool] ?? [:]
    let key = json["key"] as? String ?? ""

    switch type {
    case "mousemove":
        postMouse(.mouseMoved, x: x, y: y, button: .left)

    case "mousedown", "click":
        let isClick = type == "click"
        switch button {
        case "right":
            postMouse(.rightMouseDown, x: x, y: y, button: .right)
            if isClick { postMouse(.rightMouseUp, x: x, y: y, button: .right) }
        case "middle":
            postMouse(.otherMouseDown, x: x, y: y, button: .center)
            if isClick { postMouse(.otherMouseUp, x: x, y: y, button: .center) }
        default:
            postMouse(.leftMouseDown, x: x, y: y, button: .left)
            if isClick { postMouse(.leftMouseUp, x: x, y: y, button: .left) }
        }

    case "mouseup":
        switch button {
        case "right": postMouse(.rightMouseUp, x: x, y: y, button: .right)
        case "middle": postMouse(.otherMouseUp, x: x, y: y, button: .center)
        default: postMouse(.leftMouseUp, x: x, y: y, button: .left)
        }

    case "wheel":
        let dy = Int32(-((json["deltaY"] as? NSNumber)?.intValue ?? 0) / 5)
        let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                            wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0)
        event?.post(tap: .cghidEventTap)

    case "keydown", "keyup":
        let isDown = type == "keydown"
        if let kc = fullKeyMap[key] ?? fullKeyMap[key.lowercased()] {
            var flags = CGEventFlags()
            if mods["shift"] == true || (key.count == 1 && key.first?.isUppercase == true) { flags.insert(.maskShift) }
            if mods["ctrl"] == true  { flags.insert(.maskControl) }
            if mods["alt"] == true   { flags.insert(.maskAlternate) }
            if mods["meta"] == true  { flags.insert(.maskCommand) }
            postKey(kc, down: isDown, flags: flags)
        }

    default: break
    }
}

import type { Pointer } from 'bun:ffi';

export type { HRESULT, NULL } from '@bun-win32/core';

export enum GameInputGamepadButtons {
  GameInputGamepadA = 0x0000_0004,
  GameInputGamepadB = 0x0000_0008,
  GameInputGamepadC = 0x0000_4000,
  GameInputGamepadDPadDown = 0x0000_0080,
  GameInputGamepadDPadLeft = 0x0000_0100,
  GameInputGamepadDPadRight = 0x0000_0200,
  GameInputGamepadDPadUp = 0x0000_0040,
  GameInputGamepadLeftShoulder = 0x0000_0400,
  GameInputGamepadLeftThumbstick = 0x0000_1000,
  GameInputGamepadLeftThumbstickDown = 0x0008_0000,
  GameInputGamepadLeftThumbstickLeft = 0x0010_0000,
  GameInputGamepadLeftThumbstickRight = 0x0020_0000,
  GameInputGamepadLeftThumbstickUp = 0x0004_0000,
  GameInputGamepadLeftTriggerButton = 0x0001_0000,
  GameInputGamepadMenu = 0x0000_0001,
  GameInputGamepadNone = 0x0000_0000,
  GameInputGamepadPaddleLeft1 = 0x0400_0000,
  GameInputGamepadPaddleLeft2 = 0x0800_0000,
  GameInputGamepadPaddleRight1 = 0x1000_0000,
  GameInputGamepadPaddleRight2 = 0x2000_0000,
  GameInputGamepadRightShoulder = 0x0000_0800,
  GameInputGamepadRightThumbstick = 0x0000_2000,
  GameInputGamepadRightThumbstickDown = 0x0080_0000,
  GameInputGamepadRightThumbstickLeft = 0x0100_0000,
  GameInputGamepadRightThumbstickRight = 0x0200_0000,
  GameInputGamepadRightThumbstickUp = 0x0040_0000,
  GameInputGamepadRightTriggerButton = 0x0002_0000,
  GameInputGamepadView = 0x0000_0002,
  GameInputGamepadX = 0x0000_0010,
  GameInputGamepadY = 0x0000_0020,
  GameInputGamepadZ = 0x0000_8000,
}

export enum GameInputKind {
  GameInputKindArcadeStick = 0x0001_0000,
  GameInputKindController = 0x0000_000e,
  GameInputKindControllerAxis = 0x0000_0002,
  GameInputKindControllerButton = 0x0000_0004,
  GameInputKindControllerSwitch = 0x0000_0008,
  GameInputKindFlightStick = 0x0002_0000,
  GameInputKindGamepad = 0x0004_0000,
  GameInputKindKeyboard = 0x0000_0010,
  GameInputKindMouse = 0x0000_0020,
  GameInputKindRacingWheel = 0x0008_0000,
  GameInputKindSensors = 0x0000_0040,
  GameInputKindUnknown = 0x0000_0000,
}

export type PIGameInput = Pointer;
export type PPVOID = Pointer;
export type REFCLSID = Pointer;
export type REFIID = Pointer;

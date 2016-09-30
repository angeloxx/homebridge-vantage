# VantagePlugin
VantageControls InFusion plugin for homebridge: https://github.com/nfarina/homebridge

# Installation
Install plugin with npm install -g homebridge-vantage
Add platform within config.json of you homebridge instance:

    {
        "platforms": [{
            "platform": "VantageControls",
            "ipaddress": "192.168.1,1"
            }], 
        "bridge": {
            "username": "CC:22:3D:E3:CE:31", 
            "name": "Vantage HomeBridge Adapter", 
            "pin": "342-52-220", 
            "port": 51826
        }, 
        "description": "My Fantastic Vantage System", 
        "accessories": []
    }

Restart homebridge
Enjoy!

# Supported Devices

Currently it should be possible to control all loads registered on you InFusion device, but I'm working on the detection of the difference with Relay, Dimmer and RGB Loads; I'm ready to support Thermostats and other devices but I prefer to keep the program stable before publish further functionalities. My test plan consists of:
- RGB Philips Hue lights and Osram Lightify (controlled by Vantage, not compatible with HomeKit)
- Legrand/BTicino MyHome Relay and Dimmer
- Legrand/BTicino MyHome Thermostat

Stay tuned!
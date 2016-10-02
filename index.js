var colorsys = require('colorsys');
var net = require('net');
var sprintf = require("sprintf-js").sprintf;
var inherits = require("util").inherits;
var parser = require('xml2json');
var extend = require('extend'), events = require('events'), util = require('util'), fs = require('fs');
var libxmljs = require("libxmljs");
var Promise = require('promise');
var Accessory, Characteristic, Service, UUIDGen;
var myRGB = []; var myTemp = [];



module.exports = function (homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	Accessory = homebridge.platformAccessory;
	UUIDGen = homebridge.hap.uuid;

	inherits(VantageLoad, Accessory);
	process.setMaxListeners(0);
	homebridge.registerPlatform("homebridge-vantage", "VantageControls", VantagePlatform);
};

class VantageInfusion {
    constructor(ipaddress, accessories, usecache) {
		util.inherits(VantageInfusion, events.EventEmitter);
        this.ipaddress = ipaddress;
        this.usecache = usecache || true;
        this.accessories = accessories || [];
        this.command = {};
		this.interfaces = {};
		this.StartCommand();
	}

	/**
	 * Start the command session. The InFusion controller (starting from the 3.2 version of the
	 * firmware) must be configured without encryption or password protection. Support to SSL
	 * and password protected connection will be introduced in the future, the IoT world is
	 * a bad place! 
	 */
	StartCommand() {
		this.command = net.connect({ host: this.ipaddress, port: 3001 }, () => {
			this.command.on('data', (data) => {
				/* Data received */
				var lines = data.toString().split('\n');
				for (var i = 0; i < lines.length; i++) {
					if (lines[i].startsWith("S:LOAD") || lines[i].startsWith("R:GETLOAD")) {
						/* Live update about load level (even if it's a RGB load') */
						var dataItem = lines[i].split(" ");
						this.emit("loadStatusChange", parseInt(dataItem[1]),parseInt(dataItem[2]));
					}
					if (lines[i].startsWith("R:INVOKE") && lines[i].indexOf("Object.IsInterfaceSupported")) {
						var dataItem = lines[i].split(" ");
						this.emit(sprintf("isInterfaceSupportedAnswer-%d-%d",parseInt(dataItem[1]),parseInt(dataItem[4])),parseInt(dataItem[2]));
					}
				}
			});			
			this.command.write(sprintf("STATUS ALL\n"));
		});
	}

	getLoadStatus(vid) {
		this.command.write(sprintf("GETLOAD %s\n", vid));
	}

	/**
	 * Send the IsInterfaceSupported request to the InFusion controller,
	 * it needs the VID of the object and the IID (InterfaceId) taken 
	 * previously with the configuration session
	 * @return true, false or a promise!
	 */
	isInterfaceSupported(item, interfaceName) {
		if (this.interfaces[interfaceName] === undefined) {
			return new Promise((resolve, reject) => {
				resolve({'item': item, 'interface': interfaceName, 'support':false});
			});
		} else {
			/**
			 * Sample
			 *   OUT| INVOKE 2774 Object.IsInterfaceSupported 32
			 *    IN| R:INVOKE 2774 0 Object.IsInterfaceSupported 32
			 */
			var interfaceId = this.interfaces[interfaceName];
			
			return new Promise((resolve, reject) => {
				this.once(sprintf("isInterfaceSupportedAnswer-%d-%d",parseInt(item.VID),parseInt(interfaceId)), (_support) => {
					resolve({'item': item, 'interface': interfaceName, 'support':_support});
				}
				);
				this.command.write(sprintf("INVOKE %s Object.IsInterfaceSupported %s\n", item.VID,interfaceId));
			});
		}
	}	

	/**
	 * Start the discovery procedure that use the local cache or download from the InFusion controller
	 * the last configuration saved on the SD card (usually the developer save a backup copy of the configuration
	 * on this support but in some cases it can be different from the current running configuration, I need to
	 * check how to download it with a single pass procedure)
	 */
	Discover() {
		var configuration = net.connect({ host: this.ipaddress, port: 2001 }, () => {
			/**
			 * List interfaces, list configuration and then check if a specific interface 
			 * is supported by the recognized devices. 
			 */

			var buffer = "";
			configuration.on('data', (data) => {
				buffer = buffer + data.toString().replace("\ufeff", "");
				try {
					buffer = buffer.replace('<?File Encode="Base64" /', '<File>');
					buffer = buffer.replace('?>', '</File>');
					libxmljs.parseXml(buffer);
				} catch (e) {
					return false;
				}
				var parsed = JSON.parse(parser.toJson(buffer));
				if (parsed.IIntrospection !== undefined) {
					var interfaces = parsed.IIntrospection.GetInterfaces.return.Interface;
					for (var i = 0; i < interfaces.length; i++) {
						this.interfaces[interfaces[i].Name] = interfaces[i].IID;
					}
				}
				if (parsed.IBackup !== undefined) {
					var xmlconfiguration = Buffer.from(parsed.IBackup.GetFile.return.File, 'base64').toString("ascii"); // Ta-da
					fs.writeFileSync("/tmp/vantage.dc", xmlconfiguration);
					this.emit("endDownloadConfiguration", xmlconfiguration);
					configuration.destroy();
				}
				buffer = "";
			});

			/* Aehm, async method becomes sync... */
			configuration.write("<IIntrospection><GetInterfaces><call></call></GetInterfaces></IIntrospection>\n");

			if (fs.existsSync('/tmp/vantage.dc') && this.usecache) {
				fs.readFile('/tmp/vantage.dc', 'utf8', function (err, data) {
					if (!err) {
						this.emit("endDownloadConfiguration", data);
					}
				}.bind(this));
			} else {
				configuration.write("<IBackup><GetFile><call>Backup\\Project.dc</call></GetFile></IBackup>\n");
			}			
		});
	}

	/**
	 * Send the set HSL color request to the controller 
	 */
    RGBLoad_DissolveHSL(vid, h, s, l, time) {
        var thisTime = time || 500;
        this.command.write(sprintf("INVOKE %s RGBLoad.DissolveHSL %s %s %s %s\n", vid, h, s, l * 1000, thisTime))
    }


	/**
	 * Send the set light level to the controller
	 */
    Load_Dim(vid, level, time) {
		// TODO: reduce feedback (or command) rate
		var thisTime = time || 1;
		if (level > 0) {
			this.command.write(sprintf("INVOKE %s Load.Ramp 6 %s %s\n", vid, thisTime, level));
		} else {
			this.command.write(sprintf("INVOKE %s Load.SetLevel %s\n", vid, level));
		}
    }
}


class VantagePlatform {

	constructor(log, config, api) {
		this.log = log;
		this.config = config || {};
		this.api = api;
		this.ipaddress = config.ipaddress;
		this.lastDiscovery = null;
		this.items = [];
		this.infusion = new VantageInfusion(config.ipaddress, this.items);
		this.infusion.Discover();
		this.pendingrequests = 0;
		this.ready = false;
		this.callbackPromesedAccessories = undefined;
		this.getAccessoryCallback = null;

		this.log("VantagePlatform for InFusion Controller at " + this.ipaddress);

		this.infusion.on('loadStatusChange', (vid,value) => {
			this.items.forEach(function (accessory) {
				if (accessory.address == vid) {
					this.log(sprintf("loadStatusChange (VID=%s, Name=%s, Bri:%d)", vid,accessory.name, value));
					accessory.bri = parseInt(value);
					accessory.power = ((value) > 0);
					if (accessory.lightBulbService !== undefined) {
						/* Is it ready? */
						accessory.lightBulbService.getCharacteristic(Characteristic.Brightness).getValue(null, accessory.bri);
						accessory.lightBulbService.getCharacteristic(Characteristic.On).getValue(null, accessory.power);
					}
				}
			}.bind(this));
		});

		this.infusion.on('endDownloadConfiguration', (configuration) => {
			this.log("VantagePlatform for InFusion Controller (end configuration download)");
			var parsed = JSON.parse(parser.toJson(configuration));
			for (var i = 0; i < parsed.Project.Objects.Object.length; i++) {
				var thisItemKey = Object.keys(parsed.Project.Objects.Object[i])[0];
				var thisItem = parsed.Project.Objects.Object[i][thisItemKey];
				if (thisItem.ExcludeFromWidgets === undefined || thisItem.ExcludeFromWidgets == "False") {
					if (thisItem.DeviceCategory == "Lighting") {
						if (thisItem.DName !== undefined && thisItem.DName != "") thisItem.Name = thisItem.DName;
							this.pendingrequests = this.pendingrequests + 1;
							this.log(sprintf("New load asked (VID=%s, Name=%s, ---)", thisItem.VID, thisItem.Name));
							this.infusion.isInterfaceSupported(thisItem,"Load").then((_response) => {
								if (_response.support) {
									if (_response.item.PowerProfile !== undefined) {
										/* Check if it is a Dimmer or a RGB Load */
										this.infusion.isInterfaceSupported(_response.item,"RGBLoad").then((_response) => {
											if (_response.support) {
												this.log(sprintf("New load added (VID=%s, Name=%s, RGB)", _response.item.Name, _response.item.VID));
												this.items.push(new VantageLoad(this.log, this, _response.item.Name, _response.item.VID, "rgb"));
											} else {
												this.log(sprintf("New load added (VID=%s, Name=%s, DIMMER)", _response.item.Name, _response.item.VID));
												this.items.push(new VantageLoad(this.log, this, _response.item.Name, _response.item.VID, "dimmer"));
											}
											this.infusion.getLoadStatus(_response.item.VID);
											this.pendingrequests = this.pendingrequests - 1;
											this.callbackPromesedAccessoriesDo();
										});
									} else {
										this.log(sprintf("New load added (VID=%s, Name=%s, RELAY)", _response.item.Name, _response.item.VID));
										this.items.push(new VantageLoad(this.log, this, _response.item.Name, _response.item.VID, "relay"));
										this.infusion.getLoadStatus(_response.item.VID);
										this.pendingrequests = this.pendingrequests - 1;
										this.callbackPromesedAccessoriesDo();
									}
								} else {
									/**
									 * This is not a valid load
									 */
									this.pendingrequests = this.pendingrequests - 1;
									this.callbackPromesedAccessoriesDo();
								}
							});
					}
				}
			}
			this.log("VantagePlatform for InFusion Controller (end configuration store)");
			this.ready = true;
			this.callbackPromesedAccessoriesDo();
		});
	}

	/**
	 * Called once, returns the list of accessories only
	 * when the list is complete
	 */
	callbackPromesedAccessoriesDo() {
		if (this.callbackPromesedAccessories !== undefined && this.ready && this.pendingrequests == 0) this.callbackPromesedAccessories(this.items);
	}

	getDevices() {
		return new Promise((resolve, reject) => {
			if (!this.ready) {
				this.log("Wait");
				this.callbackPromesedAccessories = resolve;
			} else {
				resolve(this.items);
			}
		});
	}

	/* Get accessory list */
	accessories(callback) {
		this.getDevices().then((devices) => {
			this.log("VantagePlatform for InFusion Controller (accessories readed)");
			callback(devices);
		});
	}
}

class VantageThermostat {
	constructor(log, parent, name, vid, type) {
		this.name = name;
		this.parent = parent;
		this.address = vid;
		this.log = log;
		this.temperature = 0;
		this.heating = 0;
		this.cooling = 0;
		this.type = type;
	}

}

class VantageLoad {
	constructor(log, parent, name, vid, type) {
		this.displayName = name;
		this.UUID = UUIDGen.generate(vid);
		this.name = name;
		this.parent = parent;
		this.address = vid;
		this.log = log;
		this.powerlevel = 0;
		this.bri = 100;
		this.power = 0;
		this.sat = 0;
		this.hue = 0;
		this.type = type;
	}

	isOnline(callback) {
		callback(null, true);
	}

	getServices() {
		var service = new Service.AccessoryInformation();
		service.setCharacteristic(Characteristic.Name, this.name)
			.setCharacteristic(Characteristic.Manufacturer, "Vantage Controls")
			.setCharacteristic(Characteristic.Model, "Power Switch");

		this.lightBulbService = new Service.Lightbulb(this.name);

		this.lightBulbService.getCharacteristic(Characteristic.On)
			.on('set', (level, callback) => {
				this.log("setPower");
				this.power = level;
				if (level > 0 && this.bri == 0) {
					this.bri = 100;
				}
				this.log(this.bri);
				this.log(this.power);

				this.parent.infusion.Load_Dim(this.address, this.power * this.bri);
				callback();
			})
			.on('get', (callback) => {
				callback(null, this.power > 0);
			});

		if (this.type == "dimmer" || this.type == "rgb") {
			this.lightBulbService.getCharacteristic(Characteristic.Brightness)
				.on('set', (level, callback) => {
					this.log("setBrightness");
					this.bri = level;
					this.power = (this.bri > 0);
					this.log(this.bri);
					this.log(this.power);
					this.parent.infusion.Load_Dim(this.address, this.power * this.bri);
					callback();
				})
				.on('get', (callback) => {
					this.log("getBrightness");
					this.log(this.bri);
					callback(null, this.bri);
				});
		}

		if (this.type == "rgb") {
			this.lightBulbService.getCharacteristic(Characteristic.Saturation)
				.on('set', (level, callback) => {
					this.log("setSat");
					this.power = true;
					this.sat = level;
					this.parent.infusion.RGBLoad_DissolveHSL(this.address, this.hue, this.sat, this.bri)
					callback();
				})
				.on('get', (callback) => {
					callback(null, this.sat);
				});
			this.lightBulbService.getCharacteristic(Characteristic.Hue)
				.on('set', (level, callback) => {
					this.log("setHue");
					this.power = true;
					this.hue = level;
					this.parent.infusion.RGBLoad_DissolveHSL(this.address, this.hue, this.sat, this.bri)
					callback();
				})
				.on('get', (callback) => {
					callback(null, this.hue);
				});
		}
		return [service, this.lightBulbService];
	}
}
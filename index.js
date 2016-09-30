var colorsys = require('colorsys');
var net = require('net');
var sleep = require('sleep');
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
	}

	StartCommand() {
		this.command = net.connect({ host: this.ipaddress, port: 3001 }, () => {
			this.command.write(sprintf("STATUS ALL\n"));
			if (this.accessories.length > 0) {
				for (var i = 0; i < this.accessories.length; i++) {
					if (this.accessories[i].type == 'relay' || this.accessories[i].type == 'dimmer' || this.accessories[i].type == 'rgb') {
						this.command.write(sprintf("GETLOAD %s\n", this.accessories[i].address));
					}
				}
			}
		});

		this.command.on('data', (data) => {
			/* Data received */
			var lines = data.toString().split('\n');
			for (var i = 0; i < lines.length; i++) {

				if (lines[i].startsWith("S:LOAD") || lines[i].startsWith("R:GETLOAD")) {
					/* Live update about load level (even if it's a RGB load') */
					var dataItem = lines[i].split(" ");
					this.accessories.forEach(function (accessory) {
						if (accessory.address == parseInt(dataItem[1])) {
							accessory.bri = parseInt(dataItem[2]);
							accessory.power = (parseInt(dataItem[2]) > 0);
							accessory.lightBulbService.getCharacteristic(Characteristic.Brightness).getValue(null, accessory.bri);
							accessory.lightBulbService.getCharacteristic(Characteristic.On).getValue(null, accessory.power);
						}
					});
				}
			}
		});


	}

	Discover() {

		if (fs.existsSync('/tmp/vantage.dc') && this.usecache) {
			fs.readFile('/tmp/vantage.dc', 'utf8', function (err, data) {
				if (!err) {
					this.emit("endDownloadConfiguration", data);
				}
			}.bind(this));
		}

		this.command = net.connect({ host: this.ipaddress, port: 3001 }, () => {

		});


		var configuration = net.connect({ host: this.ipaddress, port: 2001 }, () => {
			// Download interfaces
			// Download configuration
			// Check if interface is supported
			// INVOKE 2774 Object.IsInterfaceSupported 1448819456

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
				}


				buffer = "";
			});

			/* Aehm, async method becomes sync... */
			configuration.write("<IIntrospection><GetInterfaces><call></call></GetInterfaces></IIntrospection>\n");
			configuration.write("<IBackup><GetFile><call>Backup\\Project.dc</call></GetFile></IBackup>\n");

		});
	}

    RGBLoad_DissolveHSL(vid, r, g, b, time) {
        var thisTime = time || 500;
        this.command.write(sprintf("INVOKE %s RGBLoad.DissolveHSL %s %s %s %s\n", vid, r, g, b, thisTime))
    }
    Load_Dim(vid, level, time) {
		// TODO: reduce feedback (or command) rate
		var thisTime = time || 1;
		if (level > 0) {
			this.command.write(sprintf("INVOKE %s Load.Ramp 6 %s %s\n", vid, thisTime, level));
		} else {
			this.command.write(sprintf("INVOKE %s Load.SetLevel %s\n", vid, level));
		}
		// this.command.write(sprintf("LOAD %s %s\n",vid,level))
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
		this.ready = false;
		this.callbackPromise = undefined;
		this.getAccessoryCallback = null;

		this.log("VantagePlatform for InFusion Controller at " + this.ipaddress);

		this.infusion.on('endDownloadConfiguration', (configuration) => {
			this.log("VantagePlatform for InFusion Controller (end configuration download)");
			var parsed = JSON.parse(parser.toJson(configuration));
			for (var i = 0; i < parsed.Project.Objects.Object.length; i++) {
				var thisItemKey = Object.keys(parsed.Project.Objects.Object[i])[0];
				var thisItem = parsed.Project.Objects.Object[i][thisItemKey];
				if (thisItem.ExcludeFromWidgets === undefined || thisItem.ExcludeFromWidgets == "False") {
					if (thisItem.DeviceCategory == "Lighting") {
						var name = thisItem.Name;
						if (thisItem.DName !== undefined && thisItem.DName != "") name = thisItem.DName;
						if (thisItem.PowerProfile !== undefined) {
							this.items.push(new VantageLoad(this.log, this, name, thisItem.VID, "dimmer"));
						} else {
							this.items.push(new VantageLoad(this.log, this, name, thisItem.VID, "relay"));
						}
						this.log(sprintf("New load added (VID=%s, Name=%s)", thisItem.VID, name));

						// this.api.registerPlatformAccessories("homebridge-vantage", "VantageControls", [this.items[this.items.length - 1]]);
					}
				}
			}
			this.log("VantagePlatform for InFusion Controller (end configuration store)");
			this.ready = true;
			if (this.callbackPromise != undefined) {
				this.callbackPromise(this.items);
			}
		});
	}

	getDevices() {
		return new Promise((resolve, reject) => {
			if (!this.ready) {
				this.log("Wait");
				this.callbackPromise = resolve;
			} else {
				resolve(this.items);
			}
		});
	}

	/* Get accessory list */
	accessories(callback) {
		this.getDevices().then((devices) => {
			this.log("Yooo");
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
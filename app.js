#!/usr/bin/env node

var tab = require('tabalot');
var path = require('path');
var fs = require('fs');
var profiles = require('./profiles');

var HOME = process.env.HOME || process.env.USERPROFILE;

var REGIONS = [
	'ap-northeast-1', 'ap-southeast-1', 'ap-southeast-2', 'eu-west-1', 'sa-east-1', 'us-east-1', 'us-west-1', 'us-west-2'
];

var TYPES = [
	't1.micro', 'm1.small', 'm1.medium', 'm1.large', 'm1.xlarge', 'm2.xlarge', 'm2.2xlarge', 'm2.4xlarge', 'm3.xlarge',
	'm3.2xlarge', 'c1.medium', 'c1.xlarge', 'hi1.4xlarge', 'hs1.8xlarge', 'cc1.4xlarge', 'cc2.8xlarge', 'cg1.4xlarge', 'cr1.8xlarge'
];

var USERS = [
	'ubuntu', 'ec2-user', 'root'
];

var noop = function() {};

var profile = function(opts) {
	return profiles.get(opts.profile);
};

var kirby = function(opts) {
	return require('./index')(profile(opts));
};

var error = function(err) {
	console.error(err.message || err);
	process.exit(1);
};

var help = function() {
	error(fs.readFileSync(path.join(__dirname, 'help'), 'utf-8'));
};

var output = function(list, color) {
	var format = function(item) {
		if (typeof item !== 'object' || !item) return item;
		return Object.keys(item).reduce(function(result, key) {
			var value = item[key];

			if (typeof value === 'function') return result;
			if (value === undefined) value = null;
			if (value && value.toGMTString) value = value.toGMTString();

			result[key.replace(/([A-Z])/g, '-$1').toLowerCase()] = value;
			return result;
		}, {});
	};

	var print = function(result) {
		if (color === false) return result.length && console.log(result.join('\n'));
		console.log(require('prettyjson').render(result));
	};

	if (Array.isArray(list)) print(list.map(format));
	else print(format(list));
};

var instanceProperty = function(name, opts, callback) {
	if (profile(opts).cache(name)) return callback(null, profile(opts).cache(name));
	kirby(opts).instances(function(err, list) {
		if (err) return callback(err);

		var uniq = {};
		list.forEach(function(instance) {
			uniq[instance[name]] = true;
		});

		callback(null, profile(opts).cache(name, Object.keys(uniq)));
	});
};

var names = function(word, opts, callback) {
	instanceProperty(word.slice(0,2) === 'i-' ? 'id' : 'name', opts, callback);
};

var profileNames = function(callback) {
	callback(null, profiles.names());
};

tab('*')
	('--profile', '-p', profileNames);

tab('profile')(profileNames)
	('--access', '-a')
	('--secret', '-s')
	('--default', '-d')
	('--region', REGIONS)
	(function(name, opts) {
		var old = profiles.get(name || opts.profile) || {};
		var profile = {};

		profile.name = opts.default ? 'default' : old.name || name || opts.profile || 'default';
		profile.access = opts.access || old.access;
		profile.secret = opts.secret || old.secret;
		profile.region = opts.region || old.region;

		if (!profile.region || !profile.access || !profile.secret) {
			return error('you need to specify\n--access [access-key]\n--secret [secret-key]\n--region [region]');
		}

		require('./index')(profile).describe(function(err, description) {
			if (err) return error('profile could not be authenticated');
			profile = profiles.save(profile);
			output(profile);
		});
	});

tab('script')(names)
	(function(name, opts) {
		kirby(opts).script(name, function(err, script) {
			if (err) return callback(err);
			if (!script) return error('no script available');
			console.log(script);
		});
	});

tab('list')(names)
	('--running', '-r')
	('--one')
	(function(name, opts) {
		kirby(opts).instances(name, opts, function(err, instances) {
			if (err) return error(err);
			output(opts.one ? instances.shift() : instances);
		});
	});

tab('hostnames')(names)
	(function(name, opts) {
		kirby(opts).hostnames(name, function(err, list) {
			if (err) return error(err);
			output(list, false);
		});
	});

var script = function(val, def, callback) {
	if (val === true) {
		var tmp = path.join(require('os').tmpDir(), 'script.sh');
		fs.writeFileSync(tmp, def || '');
		require('./editor')(tmp, function(err) {
			if (err) return error(err);
			def = fs.readFileSync(tmp, 'utf-8');
			fs.unlinkSync(tmp);
			callback(def);
		});
		return;
	}

	if (!fs.existsSync(val)) return error('script file does not exist');
	callback(fs.readFileSync(val, 'utf-8'));
};

tab('exec')(names)
	('--user', '-u', ['ubuntu', 'ec2-user', 'root'])
	('--one')
	('--command', '-c')
	('--key', '-k', '-i', '@file')
	('--script', '-s', '@file')
	(function(name, opts) {
		var key = opts.key || path.join(HOME, '.ssh', 'id_rsa');
		if (fs.existsSync(key)) opts.key = fs.readFileSync(key);
		else error('key file does not exist');

		var proc = kirby(opts).exec(name, opts);

		proc.on('error', error);
		proc.pipe(process.stdout);

		if (opts.command) return proc.end(opts.command);

		if (opts.script) {
			var def = ''+
				'#!/bin/bash\n'+
				'# This script in run on the instances\n';

			script(opts.script, def, function(val) {
				proc.end(val);
			});
			return;
		}

		process.stdin.pipe(proc);
	});

var knownImages = function(opts, callback) {
	var prof = profile(opts);

	if (!prof) return callback();
	if (prof.cache('images')) return callback(null, prof.cache('images'));

	var request = require('request');
	request('http://cloud-images.ubuntu.com/locator/ec2/releasesTable', function(err, response) {
		if (err) return callback(err);

		var body = JSON.parse(response.body.replace(/,\s+\]/, ']'));
		var images = {};

		body.aaData.forEach(function(ami) {
			if (ami[2] === 'Devel' || ami[2].indexOf(' EOL') > -1 || ami[0] !== prof.region) return;
			images['ubuntu-'+ami.slice(2, 5).join('-').replace(' LTS', '')] = ami[6].match(/>(.*)</)[1];
		});

		callback(null, prof.cache('images', images));
	});
};

var complete = function(key) {
	return function(word, opts, callback) {
		if (profile(opts).cache('description')) return callback(null, profile(opts).cache('description')[key]);
		kirby(opts).describe(function(err, desc) {
			if (err) return callback(err);
			profile(opts).cache('description', desc);
			callback(null, desc[key]);
		});
	};
};

var completeImages = function(word, opts, callback) {
	knownImages(opts, function(err, images) {
		if (err) return callback(err);
		callback(null, Object.keys(images));
	});
};

var clearCache = function(opts) {
	profile(opts).cache('name', null);
	profile(opts).cache('id', null);
};

tab('launch')(names)
	('--type', '-t', TYPES)
	('--zone', '-z', complete('zones'))
	('--key', '-k', complete('keys'))
	('--group', '-g', complete('groups'))
	('--role', '-r', complete('roles'))
	('--load-balancer', '-l', complete('loadBalancers'))
	('--script', '-s', '@file')
	('--ami', '-i', completeImages)
	('--wait', '-w')
	('--defaults', '-d')
	('--no-defaults')
	(function(name, opts) {
		var ready = function() {
			knownImages(opts, function(err, images) {
				if (err) return error(err);
				opts.ami = images[opts.ami] || opts.ami;
				opts.loadBalancer = opts['load-balancer'];
				kirby(opts).launch(name, opts, function(err, instance) {
					if (err) return error(err);
					clearCache(opts);
					output(instance);
				});
			});
		};

		if (!opts.script) return ready();

		var def = ''+
			'#!/bin/bash\n'+
			'# This script is run on boot\n'+
			'# Use "kirby script" to view other instances boot script\n';

		script(opts.script, def, function(val) {
			opts.script = val;
			ready();
		});
	});

tab('terminate')(names)
	(function(name, opts) {
		kirby(opts).terminate(name, function(err, inst) {
			if (err) return error(err);
			clearCache(opts);
			output(inst);
		});
	});

tab(help);

tab.parse() || help();
#!/usr/bin/env node

var tab = require('tabalot');
var path = require('path');
var fs = require('fs');
var profiles = require('./profiles');

var HOME = process.env.HOME || process.env.USERPROFILE;
var USERS = ['ubuntu', 'ec2-user', 'root'];

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

var kirby = function(opts) {
	return require('./index')({
		region:opts.region,
		key:opts['aws-access-key'],
		secret:opts['aws-secret-key']
	});
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
	opts = profiles.defaults(opts);

	if (opts.cache(name)) return callback(null, opts.cache(name));
	kirby(opts).instances(function(err, list) {
		if (err) return callback(err);

		var uniq = {};
		list.forEach(function(instance) {
			uniq[instance[name]] = true;
		});

		callback(null, opts.cache(name, Object.keys(uniq)));
	});
};

var names = function(word, opts, callback) {
	instanceProperty(word.slice(0,2) === 'i-' ? 'instanceId' : 'name', opts, callback);
};

var profileNames = function(callback) {
	callback(null, profiles.names());
};

tab('*')
	('--profile', '-p', profileNames);

tab('profile')(profileNames)
	('--aws-access-key', '-a')
	('--aws-secret-key', '-s')
	('--region', '-r', REGIONS)
	('--force', '-f')
	(function(name, opts) {
		opts = profiles.defaults(name || opts.profile || 'default', opts);

		var profile = {};
		profile.profile = opts.profile;
		profile.region = opts.region;
		profile['aws-access-key'] = opts['aws-access-key'];
		profile['aws-secret-key'] = opts['aws-secret-key'];

		if (!opts.force && (!profile.region || !profile['aws-access-key'] || !profile['aws-secret-key'])) {
			return error('you need to specify\n--aws-access-key [access-key]\n--aws-secret-key [secret-key]\n--region [region]');
		}

		var onvalidated = function() {
			profile = profiles.save(profile);
			output(profile);
		};

		if (opts.force) return onvalidated();

		kirby(profile).describe(function(err, description) {
			if (err) return error('profile could not be authenticated');
			onvalidated();
		});
	});

tab('script')(names)
	(function(name, opts) {
		opts = profiles.defaults(opts);

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
		opts = profiles.defaults(opts);

		kirby(opts).instances(name, opts, function(err, instances) {
			if (err) return error(err);
			output(opts.one ? instances.shift() : instances);
		});
	});

tab('hostnames')(names)
	(function(name, opts) {
		opts = profiles.defaults(opts);

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
	('--user', '-u', USERS)
	('--one')
	('--command', '-c')
	('--key', '-k', '-i', '@file')
	('--script', '-s', '@file')
	(function(name, opts) {
		opts = profiles.defaults(opts);

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
	opts = profiles.defaults(opts);

	if (!opts) return callback();
	if (opts.cache('amis')) return callback(null, opts.cache('amis'));

	var request = require('request');
	request('http://cloud-images.ubuntu.com/locator/ec2/releasesTable', function(err, response) {
		if (err) return callback(err);

		var body = JSON.parse(response.body.replace(/,\s+\]/, ']'));
		var images = {};

		body.aaData.forEach(function(ami) {
			if (ami[2] === 'Devel' || ami[2].indexOf(' EOL') > -1 || ami[0] !== opts.region) return;
			images['ubuntu-'+ami.slice(2, 5).join('-').replace(' LTS', '')] = ami[6].match(/>(.*)</)[1];
		});

		callback(null, opts.cache('amis', images));
	});
};

var complete = function(key) {
	return function(word, opts, callback) {
		opts = profiles.defaults(opts);

		if (opts.cache('description')) return callback(null, opts.cache('description')[key]);
		kirby(opts).describe(function(err, desc) {
			if (err) return callback(err);
			opts.cache('description', desc);
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
	opts.cache('name', null);
	opts.cache('instanceId', null);
};

tab('launch')(names)
	('--instance-type', '-t', TYPES)
	('--availability-zone', '-z', complete('availabilityZones'))
	('--key-name', '-k', complete('keyNames'))
	('--security-group', '-g', complete('securityGroups'))
	('--iam-role', '-r', complete('iamRoles'))
	('--load-balancer', '-l', complete('loadBalancers'))
	('--script', '-s', '@file')
	('--ami', '-i', completeImages)
	('--wait', '-w')
	('--defaults', '-d')
	('--no-defaults')
	(function(name, opts) {
		opts = profiles.defaults(opts);

		var ready = function() {
			knownImages(opts, function(err, images) {
				if (err) return error(err);

				var ami = images[opts.ami] || opts.ami;

				if (ami) opts.ami = ami;
				if (opts['key-name']) opts.keyName = opts['key-name'];
				if (opts['availability-zone']) opts.availabilityZone = opts['availability-zone'];
				if (opts['load-balancer']) opts.loadBalancer = opts['load-balancer'];
				if (opts['security-group']) opts.securityGroup = opts['security-group'];
				if (opts['iam-role']) opts.iamRole = opts['iam-role'];

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
		opts = profiles.defaults(opts);

		kirby(opts).terminate(name, function(err, inst) {
			if (err) return error(err);
			clearCache(opts);
			output(inst);
		});
	});

tab(help);

tab.parse() || help();
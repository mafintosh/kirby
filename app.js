#!/usr/bin/env node

var tab = require('tabalot');
var path = require('path');
var fs = require('fs');
var profiles = require('./profiles');

var HOME = process.env.HOME || process.env.USERPROFILE;
var USERS = ['ubuntu', 'ec2-user', 'root'];
var INSTANCE_DOCUMENT = 'http://169.254.169.254/latest/dynamic/instance-identity/document';

var SELECTIONS = [
	'instance-id', 'name', 'load-balancer', 'public-dns', 'instance-type', 'security-group', 'iam-role',
	'launch-time', 'instance-state', 'availability-zone', 'key-name', 'ami', 'private-dns'
];

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

var camelize = function(prop) {
	return prop.replace(/-(.)/, function(_, ch) {
		return ch.toUpperCase();
	});
};

var uncamelize = function(prop) {
	return prop.replace(/([A-Z])/g, '-$1').toLowerCase();
};

var kirby = function(opts) {
	return require('./index')({
		region:opts.region,
		key:opts['aws-access-key'],
		secret:opts['aws-secret-key'],
		ssl: opts.ssl
	});
};

var error = function(err) {
	console.error(err.message || err);
	process.exit(1);
};

var help = function(opts) {
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

			result[uncamelize(key)] = value;
			return result;
		}, {});
	};

	var print = function(result) {
		if (color === false && !Array.isArray(result)) return console.log(result);
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
	if (word.slice(0,2) === 'i-') return instanceProperty('instanceId', opts, callback);
	if (word.slice(0,4) === 'ec2-') return instanceProperty('publicDns', opts, callback);
	if (word.slice(0,3) === 'ip-') return instanceProperty('privateDns', opts, callback);

	var uniq = function(value, i, list) {
		return list.indexOf(value) === i;
	};

	var prev = word.split('+').slice(0, -1).filter(function(part) {
		return part;
	});

	instanceProperty('name', opts, function(err, names) {
		if (err) return callback(err);

		names = names
			.map(function(word) {
				return word ? word.split('+') : [];
			})
			.filter(function(words) {
				return prev.every(function(word) {
					return words.indexOf(word) > -1;
				});
			})
			.map(function(words) {
				return words.map(function(word) {
					return prev.concat(word).filter(uniq).join('+');
				});
			});

		callback(null, Array.prototype.concat.apply([], names));
	});
};

var profileNames = function(callback) {
	callback(null, profiles.names());
};

tab('*')
	('--profile', '-p', profileNames)
	('--no-ssl');

tab('profile')(profileNames)
	('--aws-access-key', '-a')
	('--aws-secret-key', '-s')
	('--region', '-r', REGIONS)
	('--force', '-f')
	(function(name, opts) {
		opts = profiles.defaults(name || opts.profile || 'default', opts);

		var onvalidated = function() {
			opts = profiles.save(opts);

			var filtered = ['profile', 'aws-access-key', 'aws-secret-key', 'region'].reduce(function(result, key) {
				if (opts[key]) result[key] = opts[key];
				return result;
			}, {});

			output(filtered);
		};

		var validate = function() {
			if (opts.force) return onvalidated();

			kirby(opts).instances(function(err) {
				if (!err) return onvalidated();

				var missing = '';
				if (!opts['aws-access-key']) missing += '--aws-access-key [access-key]\n';
				if (!opts['aws-secret-key']) missing += '--aws-secret-key [secret-key]\n';
				if (!opts.region) missing += '--region [region]\n';

				if (!missing) return error('Profile could not be authenticated.');

				error('Profile could not be authenticated. Try specifying:\n'+missing.trim());
			});
		};

		if (opts.region !== 'auto') return validate();

		var request = require('request');

		request(INSTANCE_DOCUMENT, {json:true}, function(err, response) {
			if (err) return error(err);
			opts.region = response.body.region;
			validate();
		});
	});

tab('user-data')(names)
	(function(name, opts) {
		opts = profiles.defaults(opts);

		kirby(opts).userData(name, function(err, userData) {
			if (err) return callback(err);
			if (!userData) return error('No user-data available');
			console.log(userData);
		});
	});

tab('login')(names)
	('--key', '-k', '-i', '@file')
	('--user', '-u', USERS)
	('--one', '-1')
	(function(name, opts) {
		opts = profiles.defaults(opts);

		var inquirer = require('inquirer');
		var proc = require('child_process');

		var login = function(host) {
			var args = opts.key ? ['-i', opts.key] : [];
			var user = opts.user || 'ubuntu';
			proc.spawn('ssh', args.concat(user+'@'+host), {stdio:'inherit'});
		};

		kirby(opts).instances(name, {running:true, loadBalancers:false}, function(err, instances) {
			if (err) return error(err);
			if (!instances.length) return error('No instances found');
			if (instances.length === 1 || opts.one) return login(instances[0].publicDns);

			var padding = instances.reduce(function(max, inst) {
				return inst.name.length > max.length ? inst.name.replace(/./g, ' ') : max;
			}, '');

			inquirer.prompt({
				name: 'login',
				type: 'list',
				message: 'Select an instance',
				choices: instances.map(function(inst) {
					return inst.name+padding.slice(inst.name.length)+'  '+inst.instanceId+'  '+inst.publicDns;
				}).sort()
			}, function(opts) {
				var host = opts.login.split(' ').pop();
				login(host);
			})
		});
	})

tab('list')(names)
	('--running', '-r')
	('--one', '-1')
	('--select', '-s', SELECTIONS)
	(function(name, opts) {
		opts = profiles.defaults(opts);

		kirby(opts).instances(name, opts, function(err, instances) {
			if (err) return error(err);

			var uniq = function() {
				var visited = {};
				return function(prop) {
					if (!prop || visited[prop]) return false;
					return visited[prop] = true;
				};
			};

			var selects = opts.select ? [].concat(opts.select).map(camelize) : [];

			if (selects.length === 1) {
				instances = instances
					.map(function(inst) {
						inst = inst[selects[0]];
						return inst && inst.toGMTString ? inst.toGMTString() : inst;
					})
					.filter(uniq());
			}

			if (selects.length > 1) {
				instances = instances.map(function(inst) {
					return selects.reduce(function(result, key) {
						result[key] = inst[key];
						return result;
					}, {});
				});
			}

			output(opts.one ? instances.shift() : instances, selects.length !== 1);
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

	if (!fs.existsSync(val)) return error('Script file does not exist');
	callback(fs.readFileSync(val, 'utf-8'));
};

tab('exec')(names)
	('--user', '-u', USERS)
	('--one')
	('--parallel')
	('--command', '-c')
	('--key', '-k', '-i', '@file')
	('--script', '-s', '@file')
	('--user-data')
	(function(name, opts) {
		opts = profiles.defaults(opts);

		var key = opts.key || path.join(HOME, '.ssh', 'id_rsa');
		if (fs.existsSync(key)) opts.key = fs.readFileSync(key);
		else error('Key file does not exist');

		var oncommand = function(cmd) {
			var proc = kirby(opts).exec(name, cmd, opts);
			proc.on('error', error);
			proc.pipe(process.stdout);
		};

		if (opts['user-data']) opts.command = 'curl -fs http://169.254.169.254/latest/user-data > /tmp/user-data && chmod +x /tmp/user-data && sudo /tmp/user-data';
		if (opts.command && opts.command !== true) return oncommand(opts.command);

		if (opts.script) {
			var def = ''+
				'#!/bin/bash\n'+
				'# This script in run on the instances\n';

			script(opts.script, def, oncommand);
			return;
		}

		error('--script [file] or --command [command] is required')
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
	('--user-data', '-u', '@file')
	('--ami-id', '-i', completeImages)
	('--wait', '-w')
	('--defaults', '-d')
	('--no-defaults')
	(function(name, opts) {
		opts = profiles.defaults(opts);

		var ready = function() {
			knownImages(opts, function(err, images) {
				if (err) return error(err);

				var ami = images[opts['ami-id']] || opts['ami-id'];
				var set = function(prop) {
					if (opts[prop] === undefined) return;
					opts[camelize(prop)] = opts[prop];
				};

				if (ami) opts.amiId = ami;
				set('user-data');
				set('key-name');
				set('availability-zone');
				set('load-balancer');
				set('security-group');
				set('iam-role');

				kirby(opts).launch(name, opts, function(err, instance) {
					if (err) return error(err);
					clearCache(opts);
					output(instance);
				});
			});
		};

		if (!opts['user-data']) return ready();

		var def = ''+
			'#!/bin/bash\n'+
			'# user-data is run on instance boot.\n'+
			'# Run "kirby user-data" to view other instances user-data\n';

		script(opts['user-data'], def, function(val) {
			opts['user-data'] = val;
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

tab()
	('--version', '-v')
	(function(opts) {
		if (opts.version) return output('v'+require('./package').version);
		help();
	});

tab.parse() || help();
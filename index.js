var STATE_RANKS = {running:4, pending:3, stopped:2, 'shutting-down':1, terminated:0};

var getName = function(inst) {
	if (!inst.Tags) return null;
	return inst.Tags.reduce(function(name, tag) {
		return name || (tag.Key === 'Name' && tag.Value);
	}, null);
};

var getGroup = function(inst) {
	var group = inst.SecurityGroups;
	if (!group) return null;
	return group[0] && group[0].GroupName;
};

var noop = function() {};

var parallel = function(callback) {
	var result = [];
	var missing = 0;
	return function() {
		var index = missing++;
		return function(err, value) {
			if (err) {
				var tmp = callback;
				callback = noop;
				tmp(err);
				return;
			}
			result[index+1] = value;
			if (!--missing) callback.apply(null, result);
		};
	};
};

var kirby = function(config) {
	var that = {};
	var AWS = require('aws-sdk');

	if (config) {
		AWS.config.update({
			accessKeyId: config.key,
			secretAccessKey: config.secret,
			region: config.region,
			sslEnabled: config.ssl !== false
		});
	}

	var splitName = function(name) {
		return typeof name === 'string' ? name.split(/\s*\+\s*/) : (name || []);
	};

	var describeInstances = function(filter, callback) {
		var ec2 = new AWS.EC2();
		ec2.describeInstances(function(err, instances) {
			if (err) return callback(err);

			var result = [];
			instances.Reservations.forEach(function(res) {
				result = result.concat(res.Instances);
			});

			if (!filter || filter === '*') return callback(null, result);

			result = result.filter(function(inst) {
				var names = Array.prototype.concat.apply([], (inst.Tags || []).map(function(tag) {
					return tag.Key === 'Name' ? splitName(tag.Value) : [];
				}));

				if (inst.InstanceId === filter) return true;
				if (inst.PublicDnsName === filter) return true;
				if (inst.PrivateDnsName === filter) return true;
				if (inst.PrivateDnsName === filter+'.'+config.region+'.compute.internal') return true;

				return splitName(filter).every(function(f) {
					return names.indexOf(f) > -1;
				});
			});

			callback(null, result);
		});
	};

	that.describe = function(callback) {
		var ec2 = new AWS.EC2();
		var iam = new AWS.IAM();
		var elb = new AWS.ELB();

		var describeZones = function(callback) {
			ec2.describeAvailabilityZones(function(err, result) {
				if (err) return callback(err);

				var zones = result.AvailabilityZones.map(function(zone) {
					return zone.ZoneName;
				});

				callback(null, zones);
			});
		};

		var describeGroups = function(callback) {
			ec2.describeSecurityGroups(function(err, result) {
				if (err) return callback(err);

				var groups = result.SecurityGroups.map(function(group) {
					return group.GroupName;
				});

				callback(null, groups);
			});
		};

		var describeKeys = function(callback) {
			ec2.describeKeyPairs(function(err, result) {
				if (err) return callback(err);

				var keys = result.KeyPairs.map(function(key) {
					return key.KeyName;
				});

				callback(null, keys);
			});
		};

		var describeRoles = function(callback) {
			iam.listInstanceProfiles(function(err, result) {
				if (err) return callback(err);

				var roles = result.InstanceProfiles.map(function(role) {
					return role.InstanceProfileName;
				});

				callback(null, roles);
			});
		};

		var describeLoadBalancers = function(callback) {
			elb.describeLoadBalancers(function(err, elbs) {
				if (err) return callback(err);

				elbs = elbs.LoadBalancerDescriptions.map(function(elb) {
					return elb.LoadBalancerName;
				});

				callback(null, elbs);
			});
		};

		var wait = parallel(function(err, loadBalancers, roles, zones, keys, groups) {
			if (err) return callback(err);

			callback(null, {
				loadBalancers:loadBalancers,
				iamRoles:roles,
				availabilityZones:zones,
				keyNames:keys,
				securityGroups:groups
			});
		});

		describeLoadBalancers(wait());
		describeRoles(wait());
		describeZones(wait());
		describeKeys(wait());
		describeGroups(wait());
	};

	that.instances = function(filter, opts, callback) {
		if (typeof filter === 'function') return that.instances(null, null, filter);
		if (typeof opts === 'function') return that.instances(filter, null, opts);
		if (!opts) opts = {};

		var wait = parallel(function(err, instances, loadBalancers) {
			if (err) return callback(err);
			if (!loadBalancers) loadBalancers = {};

			instances = instances
				.map(function(inst) {
					return {
						instanceId: inst.InstanceId,
						name: splitName(getName(inst)).join('+'), // normalize whitespace
						loadBalancer: loadBalancers[inst.InstanceId],
						privateDns: inst.PrivateDnsName,
						publicDns: inst.PublicDnsName,
						instanceType: inst.InstanceType,
						securityGroup: getGroup(inst),
						iamRole: inst.IamInstanceProfile && inst.IamInstanceProfile.Arn.split('/').pop(),
						launchTime: inst.LaunchTime,
						instanceState: inst.State.Name,
						availabilityZone: inst.Placement.AvailabilityZone,
						keyName: inst.KeyName,
						amiId: inst.ImageId
					};
				})
				.sort(function(a, b) {
					var stateA = a.instanceState;
					var stateB = b.instanceState;
					if (stateA !== 'running' || stateB !== 'running') return (STATE_RANKS[stateB] || 0) - (STATE_RANKS[stateA] || 0);
					return b.launchTime.getTime() - a.launchTime.getTime();
				});

			if (opts.running) {
				instances = instances.filter(function(inst) {
					return inst.instanceState === 'running';
				});
			}

			callback(null, instances);
		});

		var instanceToLoadBalancer = function(callback) {
			var elb = new AWS.ELB();
			elb.describeLoadBalancers(function(err, loadBalancers) {
				if (err) return callback(err);
				var map = {};
				loadBalancers.LoadBalancerDescriptions.forEach(function(elb) {
					if (!elb.Instances) return;
					elb.Instances.forEach(function(inst) {
						map[inst.InstanceId] = elb.LoadBalancerName;
					});
				});
				callback(null, map);
			});
		};

		describeInstances(filter, wait());
		if (opts.loadBalancers !== false) instanceToLoadBalancer(wait());
	};

	var describeHostnames = function(filter, callback) {
		that.instances(filter, {loadBalancer:false}, function(err, instances) {
			if (err) return callback(err);

			var hostnames = instances
				.map(function(inst) {
					return inst.instanceState === 'running' && inst.publicDns;
				})
				.filter(function(hostname) {
					return hostname;
				});

			callback(null, hostnames);
		});
	};

	that.exec = function(filter, cmd, opts) {
		if (typeof filter === 'object' && filter) return that.exec(null, filter);
		if (!opts) opts = {};

		var exec = require('ssh-exec');
		var stream = require('stream-wrapper');
		var thunky = require('thunky');

		var result = stream.passThrough();
		result.setMaxListeners(0);

		describeHostnames(filter, function(err, hostnames) {
			if (err) return result.emit('error', err);
			if (opts.one) hostnames = hostnames.slice(0, 1);

			var run = function(host, callback) {
				var output = exec(cmd, {host:host, user:opts.user || 'ubuntu', key:opts.key});

				output.on('error', function(err) {
					result.emit('error', err);
				});

				output.on('exit', function(code) {
					result.emit('exit', code);
				});

				output.on('end', function() {
					callback();
				});

				output.pipe(result, {end:false});
			};

			var call = function(fn) {
				fn();
			};

			var loop = function() {
				var host = hostnames.shift();
				if (!host) return result.end();
				run(host, loop);
			};

			if (!opts.parallel) return loop();

			var wait = parallel(function() {
				result.end();
			});

			hostnames.forEach(function(host) {
				run(host, wait());
			});
		});

		return result;
	};

	that.userData = function(filter, callback) {
		if (typeof filter === 'function') return that.userData(null, filter);

		that.instances(filter, function(err, instances) {
			if (err) return callback(err);
			if (!instances.length) return callback();

			var id = instances[0].instanceId;
			var ec2 = new AWS.EC2();
			ec2.describeInstanceAttribute({
				InstanceId: id,
				Attribute: 'userData'
			}, function(err, result) {
				if (err) return callback(err);
				if (!result.UserData || !result.UserData.Value) return callback();

				callback(null, new Buffer(result.UserData.Value, 'base64').toString());
			});
		});
	};

	// filter MUST be specified for launch
	that.launch = function(filter, opts, callback) {
		if (typeof opts === 'function') return that.launch(filter, null, opts);
		if (typeof filter === 'function' || !filter) throw new Error('Name of instance id must be specified');
		if (!opts) opts = {};
		if (!callback) callback = noop;

		var xtend = require('xtend');
		var ec2 = new AWS.EC2();
		var elb = new AWS.ELB();

		if (opts.defaults) opts.name = filter;

		var ensureZone = function(callback) {
			if (opts.availabilityZone) return callback();
			if (!opts.loadBalancer) return callback();

			elb.describeLoadBalancers({LoadBalancerNames:[opts.loadBalancer]}, function(err, result) {
				if (err) return callback(err);
				var defaultZones = result ? result.LoadBalancerDescriptions[0].AvailabilityZones : [];
				opts.availabilityZone = defaultZones[Math.floor(Math.random() * defaultZones.length)];
				callback();
			});
		};

		var onlaunched = function(id) {
			var lookup = function(callback) {
				that.instances(id, function(err, instances) {
					if (err) return callback(err);
					callback(null, instances[0]);
				});
			};

			if (!opts.wait) return lookup(callback);

			var wait = function() {
				lookup(function(err, instance) {
					if (err) return callback(err);
					if (instance.instanceState === 'running') return callback(null, instance);
					setTimeout(wait, 2000);
				});
			};

			wait();
		};

		var launch = function() {
			if (!opts.amiId) return callback(new Error('ami is required'));

			var name = opts.name || filter;
			var conf = {};

			conf.ImageId = opts.amiId;
			conf.MinCount = conf.MaxCount = opts.count || 1;

			ensureZone(function(err) {
				if (err) return callback(err);

				if (opts.keyName) conf.KeyName = opts.keyName;
				if (opts.securityGroup) conf.SecurityGroups = [].concat(opts.securityGroup);
				if (opts.userData) conf.UserData = new Buffer(opts.userData, 'utf-8').toString('base64');
				if (opts.instanceType) conf.InstanceType = opts.instanceType;
				if (opts.availabilityZone) conf.Placement = {AvailabilityZone: opts.availabilityZone};
				if (opts.iamRole) conf.IamInstanceProfile = {Name: opts.iamRole};

				ec2.runInstances(conf, function(err, result) {
					if (err) return callback(err);

					var id = result.Instances[0].InstanceId;
					ec2.createTags({
						Resources: [id],
						Tags: [{
							Key: 'Name',
							Value: name
						}]
					}, function(err) {
						if (err) return callback(err);
						if (!opts.loadBalancer) return onlaunched(id);

						elb.registerInstancesWithLoadBalancer({
							LoadBalancerName:opts.loadBalancer,
							Instances:[id]
						}, function(err) {
							if (err) return callback(err);
							onlaunched(id);
						});
					});
				});
			});
		};

		if (opts.defaults === false) return launch();

		that.instances(opts.defaults || filter, function(err, instances) {
			if (err) return callback(err);
			if (!instances.length) return launch();

			var inst = instances[0];

			delete inst.availabilityZone;
			opts = xtend(inst, opts);

			if (opts.userData) return launch();
			that.userData(inst.instanceId, function(err, userData) {
				if (err) return callback(err);
				opts.userData = userData;
				launch();
			});

		});
	};

	// filter MUST be specified for terminate
	that.terminate = function(filter, callback) {
		if (!callback) callback = noop;
		if (!filter) throw new Error('Name of instance id must be specified');

		that.instances(filter, function(err, instances) {
			if (err) return callback(err);

			var inst = instances[0];
			if (!inst) return callback();

			var ec2 = new AWS.EC2();
			ec2.terminateInstances({InstanceIds:[inst.instanceId]}, function(err, result) {
				if (err) return callback(err);
				inst.instanceState = result.TerminatingInstances[0].CurrentState.Name;
				callback(null, inst);
			});
		});
	};

	return that;
};

module.exports = kirby;